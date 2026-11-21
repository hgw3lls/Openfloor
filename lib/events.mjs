// Events (shows, openings, workshops, workdays) and their sign-up slots.
import {currentMember} from './auth.mjs';
import {appBase, eventCancelledEmail, eventEmail, slotReminderEmail} from './email.mjs';
import {allow} from './limits.mjs';
import {audience, blocked, check, getFeatures, levelFor} from './features.mjs';
import {notify, recipients, replyFor} from './notify.mjs';
import {enqueue, flush} from './outbox.mjs';
import {formatWhen, localValue, validZone, zonedToUtc} from './schedule.mjs';

export const kinds = ['Show', 'Opening', 'Workshop', 'Workday', 'Social', 'Event'];
const HOUR = 3600000;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const fail = (error, status = 400) => ({error, status});
const label = r => r.name || r.email.split('@')[0];

function readEvent(input, current = {}) {
  const title = input.title === undefined ? current.title : clean(input.title, 140);
  if (!title) return fail('Give the event a name.');
  const timezone = clean(input.timezone, 64) || current.timezone || 'UTC';
  if (!validZone(timezone)) return fail('Choose a valid time zone.');
  let start = current.starts_at ? new Date(current.starts_at) : null;
  if (input.local !== undefined) start = zonedToUtc(clean(input.local, 16), timezone);
  if (!start) return fail('Choose when it starts.');
  const link = input.link === undefined ? current.link ?? '' : clean(input.link, 500);
  if (link && !/^https?:\/\/\S+$/i.test(link)) return fail('Links must start with http:// or https://');
  return {title, timezone, start, link,
    kind: kinds.includes(input.kind) ? input.kind : current.kind ?? 'Event',
    duration: input.duration === undefined ? current.duration ?? 120 : Math.max(15, Math.min(14 * 24 * 60, Number.parseInt(input.duration, 10) || 120)),
    location: input.location === undefined ? current.location ?? '' : clean(input.location, 200),
    description: input.description === undefined ? current.description ?? '' : clean(input.description, 4000)};
}

function readSlot(input, event) {
  const labelText = clean(input.label, 140);
  if (!labelText) return fail('Describe the slot, like “Sat 12–3 gallery sitting”.');
  const local = clean(input.local, 16);
  const start = local ? zonedToUtc(local, event.timezone) : null;
  if (local && !start) return fail('Choose a valid time for the slot.');
  return {label: labelText, start, duration: Math.max(0, Math.min(24 * 60, Number.parseInt(input.duration, 10) || 0)),
    capacity: Math.max(1, Math.min(100, Number.parseInt(input.capacity, 10) || 1))};
}

export async function slotsFor(db, eventId) {
  const slots = (await db.prepare('SELECT * FROM slots WHERE event=? ORDER BY position, starts_at NULLS LAST, label').bind(eventId).all()).results;
  const claims = (await db.prepare(`SELECT c.slot,c.member,m.name,m.email FROM claims c JOIN members m ON m.id=c.member
    JOIN slots s ON s.id=c.slot WHERE s.event=? AND m.status='active' ORDER BY c.created`).bind(eventId).all()).results;
  return slots.map(s => ({...s, taken: claims.filter(c => c.slot === s.id).length, people: claims.filter(c => c.slot === s.id)}));
}

export async function claimSlot(db, memberId, slotId, now = Date.now()) {
  const denied = await check(db, memberId, 'signups') ?? await check(db, memberId, 'events', 'view');
  if (denied) return denied;
  const slot = await db.prepare('SELECT s.*,e.starts_at AS event_start,e.duration AS event_duration FROM slots s JOIN events e ON e.id=s.event WHERE s.id=? AND e.hidden=false').bind(slotId).first();
  if (!slot) return fail('That slot is gone.', 404);
  if (new Date(slot.event_start).getTime() + slot.event_duration * 60000 < now) return fail('This event is over.', 409);
  // Only active members' sign-ups take up room.
  const taken = `(SELECT COUNT(*) FROM claims c JOIN members m ON m.id=c.member WHERE c.slot=? AND m.status='active')`;
  const result = await db.prepare(`INSERT INTO claims (slot,member,created) SELECT ?,?,? WHERE ${taken} < ?
    ON CONFLICT (slot,member) DO NOTHING`).bind(slotId, memberId, now, slotId, slot.capacity).run();
  if (!result.meta.changes) {
    const mine = await db.prepare('SELECT 1 FROM claims WHERE slot=? AND member=?').bind(slotId, memberId).first();
    return mine ? {ok: true, already: true} : fail('That slot just filled up. Try another one.', 409);
  }
  // Two people taking the last place at the same moment can both get past the
  // check above. Looking again after saving catches it: whoever then sees too
  // many backs out, so the slot never ends up over capacity.
  const {n} = await db.prepare(`SELECT ${taken}::integer AS n`).bind(slotId).first();
  if (n > slot.capacity) {
    await db.prepare('DELETE FROM claims WHERE slot=? AND member=?').bind(slotId, memberId).run();
    return fail('That slot just filled up. Try another one.', 409);
  }
  return {ok: true};
}

// "I'm going": anyone who can take part in events marks themselves going (or not).
export async function setGoing(db, memberId, eventId, going, now = Date.now()) {
  const denied = await check(db, memberId, 'events');
  if (denied) return denied;
  const e = await db.prepare('SELECT starts_at,duration FROM events WHERE id=? AND hidden=false').bind(eventId).first();
  if (!e) return fail('That event is gone.', 404);
  if (new Date(e.starts_at).getTime() + e.duration * 60000 < now) return fail('This event is over.', 409);
  if (going) await db.prepare('INSERT INTO going (event,member,created) VALUES (?,?,?) ON CONFLICT (event,member) DO NOTHING').bind(eventId, memberId, now).run();
  else await db.prepare('DELETE FROM going WHERE event=? AND member=?').bind(eventId, memberId).run();
  return {ok: true};
}

export async function unclaimSlot(db, memberId, slotId) {
  await db.prepare('DELETE FROM claims WHERE slot=? AND member=?').bind(slotId, memberId).run();
  return {ok: true};
}

const view = (e, me) => ({id: e.id, title: e.title, kind: e.kind, startsAt: new Date(e.starts_at).toISOString(), duration: e.duration, timezone: e.timezone,
  when: formatWhen(new Date(e.starts_at), e.timezone), local: localValue(new Date(e.starts_at), e.timezone), location: e.location, link: e.link,
  description: e.description, hidden: e.hidden, author: e.name ? label(e) : '', mine: !!me && e.author === me.id});

export async function listEvents(db, me, now = Date.now()) {
  const organizer = me.role === 'organizer';
  const rows = (await db.prepare(`SELECT e.*,m.name,m.email,
      (SELECT COALESCE(SUM(s.capacity),0)::integer FROM slots s WHERE s.event=e.id) AS spots,
      (SELECT COUNT(*)::integer FROM claims c JOIN slots s ON s.id=c.slot WHERE s.event=e.id) AS taken,
      (SELECT COUNT(*)::integer FROM claims c JOIN slots s ON s.id=c.slot WHERE s.event=e.id AND c.member=?) AS mine_count,
      (SELECT COUNT(*)::integer FROM going g JOIN members gm ON gm.id=g.member WHERE g.event=e.id AND gm.status='active') AS going_count,
      EXISTS (SELECT 1 FROM going g WHERE g.event=e.id AND g.member=?) AS im_going
    FROM events e LEFT JOIN members m ON m.id=e.author WHERE (e.hidden=false OR ?) ORDER BY e.starts_at`).bind(me.id, me.id, organizer).all()).results;
  const list = rows.map(e => ({...view(e, me), spots: e.spots, taken: e.taken, signedUp: e.mine_count > 0, goingCount: e.going_count, going: !!e.im_going,
    past: new Date(e.starts_at).getTime() + e.duration * 60000 < now}));
  return {upcoming: list.filter(e => !e.past), past: list.filter(e => e.past).reverse().slice(0, 30)};
}

export async function mySlots(db, memberId, now = Date.now()) {
  return (await db.prepare(`SELECT s.id,s.label,s.starts_at,e.id AS event,e.title,e.starts_at AS event_start,e.timezone,e.duration FROM claims c
    JOIN slots s ON s.id=c.slot JOIN events e ON e.id=s.event WHERE c.member=? AND e.hidden=false AND e.starts_at + make_interval(mins => e.duration) > ?
    ORDER BY COALESCE(s.starts_at, e.starts_at)`).bind(memberId, new Date(now).toISOString()).all()).results
    .map(s => ({id: s.id, label: s.label, event: s.event, eventTitle: s.title, when: formatWhen(new Date(s.starts_at ?? s.event_start), s.timezone)}));
}

async function announce(db, mailer, base, event, kind, list) {
  if (!mailer) return 0;
  const features = await getFeatures(db);
  const slots = features.signups === 'full' ? await slotsFor(db, event.id) : [];
  list ??= await recipients(db, await audience(db, 'events', ...(kind === 'help' ? ['signups'] : [])));
  return notify(db, mailer, null, async sub => eventEmail({sub, base, event, slots, kind, canGo: features.events === 'full', replyTo: await replyFor(db, sub, 'event', event.id)}), list);
}

// Daily: the day-before reminder for each sign-up (or the event, if the slot has no time).
export async function remindSlots(db, mailer, base, now = Date.now()) {
  if (!mailer || !base) return 0;
  const due = (await db.prepare(`SELECT s.*,e.title,e.timezone,e.location,e.starts_at AS event_start,e.id AS event_id FROM slots s JOIN events e ON e.id=s.event
    WHERE s.reminded=false AND e.hidden=false AND COALESCE(s.starts_at, e.starts_at) > ? AND COALESCE(s.starts_at, e.starts_at) <= ?`)
    .bind(new Date(now).toISOString(), new Date(now + 36 * HOUR).toISOString()).all()).results;
  let sent = 0;
  for (const s of due) {
    const event = {id: s.event_id, title: s.title, timezone: s.timezone, location: s.location, starts_at: s.event_start};
    const people = (await db.prepare(`SELECT m.id,m.email,m.name,m.token FROM claims c JOIN members m ON m.id=c.member
      WHERE c.slot=? AND m.status='active' AND m.emails='all' AND m.notify_signups ${(await audience(db, 'events', 'signups')).replace('role', 'm.role')}`).bind(s.id).all()).results;
    const messages = [];
    for (const sub of people) messages.push(slotReminderEmail({sub, base, event, slot: s, replyTo: await replyFor(db, sub, 'event', event.id)}));
    sent += await enqueue(db, '', messages, now);
    await db.prepare('UPDATE slots SET reminded=true WHERE id=?').bind(s.id).run();
  }
  return sent;
}

export async function events(request, db, mailer = null, defer = null, now = Date.now()) {
  let queued = false;
  const response = await handle();
  if (queued && mailer && defer) defer(flush(db, mailer).catch(error => console.error('Outbox flush failed', error.code ?? error.name)));
  return response;

  async function handle() {
    const url = new URL(request.url), base = appBase(request), action = url.searchParams.get('action') || '';
    const run = (sql, ...args) => db.prepare(sql).bind(...args);
    const me = await currentMember(request, db, now);
    if (!me) return json({error: 'Sign in to see events.'}, 401);
    const organizer = me.role === 'organizer';
    const load = async id => uuid(id) ? run('SELECT e.*,m.name,m.email FROM events e LEFT JOIN members m ON m.id=e.author WHERE e.id=?', id).first() : null;
    const features = await getFeatures(db), level = key => levelFor(features, me.role, key);
    if (level('events') === 'off') return json(blocked(features, 'events'), 403);
    const canEdit = e => organizer || (e.author === me.id && level('events') === 'full');

    if (request.method === 'GET') {
      const id = url.searchParams.get('event');
      if (!id) return json({kinds, ...await listEvents(db, me, now)});
      const e = await load(id);
      if (!e || (e.hidden && !organizer)) return json({error: 'Event not found.'}, 404);
      const slots = level('signups') === 'off' ? [] : (await slotsFor(db, e.id)).map(s => ({id: s.id, label: s.label, capacity: s.capacity, taken: s.taken, duration: s.duration,
        when: s.starts_at ? formatWhen(new Date(s.starts_at), e.timezone) : '', local: s.starts_at ? localValue(new Date(s.starts_at), e.timezone) : '',
        people: s.people.map(p => ({id: p.member, name: label(p)})), mine: s.people.some(p => p.member === me.id)}));
      const comments = (await run(`SELECT c.id,c.body,c.via,c.created,c.author,m.name,m.email FROM comments c JOIN members m ON m.id=c.author
        WHERE c.kind='event' AND c.target=? AND c.hidden=false ORDER BY c.created`, e.id).all()).results
        .map(c => ({id: c.id, body: c.body, via: c.via, created: Number(c.created), author: label(c), mine: c.author === me.id}))
        .filter(() => level('comments') !== 'off');
      const goingPeople = (await run(`SELECT g.member,m.name,m.email FROM going g JOIN members m ON m.id=g.member WHERE g.event=? AND m.status='active' ORDER BY g.created`, e.id).all()).results;
      return json({kinds, me: {id: me.id, role: me.role}, event: {...view(e, me), canEdit: canEdit(e), announced: e.announced, slots, comments,
        goingPeople: goingPeople.map(label), going: goingPeople.some(g => g.member === me.id),
        past: new Date(e.starts_at).getTime() + e.duration * 60000 < now}});
    }
    if (request.method !== 'POST') return json({error: 'Method unavailable.'}, 405);
    if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return json({error: 'Invalid request.'}, 403);
    const raw = await request.text();
    if (raw.length > 30000) return json({error: 'This is too long.'}, 413);
    let input;
    try { input = JSON.parse(raw) ?? {}; } catch { return json({error: 'Invalid entry.'}, 400); }
    const done = (result, extra = {}) => result.error ? json({error: result.error}, result.status) : json({ok: true, ...extra});

    if (action === 'create') {
      if (level('events') !== 'full') return json(blocked(features, 'events'), 403);
      if (!await allow(db, 'event:' + me.id, 20, HOUR, now)) return json({error: 'Too many events. Try again in an hour.'}, 429);
      const e = readEvent(input);
      if (e.error) return done(e);
      const id = crypto.randomUUID();
      await run('INSERT INTO events (id,title,kind,starts_at,duration,timezone,location,link,description,author,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, e.title, e.kind, e.start.toISOString(), e.duration, e.timezone, e.location, e.link, e.description, me.id, now).run();
      return json({ok: true, id}, 201);
    }
    if (action === 'going') {
      if (!uuid(input.event)) return json({error: 'Choose an event.'}, 400);
      return done(await setGoing(db, me.id, input.event, !!input.going, now));
    }
    if (action === 'claim' || action === 'unclaim') {
      if (!uuid(input.slot)) return json({error: 'Choose a slot.'}, 400);
      return done(action === 'claim' ? await claimSlot(db, me.id, input.slot, now) : await unclaimSlot(db, me.id, input.slot));
    }

    const e = await load(input.event);
    if (!e) return json({error: 'Event not found.'}, 404);
    if (!canEdit(e)) return json({error: 'Only the person who added this event, or an organizer, can change it.'}, 403);

    if (action === 'update') {
      const next = readEvent(input, e);
      if (next.error) return done(next);
      await run('UPDATE events SET title=?,kind=?,starts_at=?,duration=?,timezone=?,location=?,link=?,description=? WHERE id=?',
        next.title, next.kind, next.start.toISOString(), next.duration, next.timezone, next.location, next.link, next.description, e.id).run();
      if (next.start.getTime() !== new Date(e.starts_at).getTime()) await run('UPDATE slots SET reminded=false WHERE event=?', e.id).run();
      return json({ok: true});
    }
    if (action === 'delete') {
      // Optionally tell people first: everyone if the event was emailed to everyone, else those signed up.
      let count = 0;
      const upcoming = new Date(e.starts_at).getTime() + e.duration * 60000 > now;
      if (input.notify && upcoming && mailer) {
        const helpers = new Set((await run('SELECT DISTINCT c.member FROM claims c JOIN slots s ON s.id=c.slot WHERE s.event=?', e.id).all()).results.map(r => r.member));
        const list = e.announced ? await recipients(db) : (await recipients(db)).filter(m => helpers.has(m.id));
        count = await notify(db, mailer, null, sub => eventCancelledEmail({sub, base, event: e, signedUp: helpers.has(sub.id)}), list);
        if (count) queued = true;
      }
      await run("DELETE FROM comments WHERE kind='event' AND target=?", e.id).run();
      await run("DELETE FROM reply_keys WHERE kind='event' AND target=?", e.id).run();
      await run('DELETE FROM events WHERE id=?', e.id).run();
      return json({ok: true, notice: 'Event deleted.' + (count ? ` Sending to ${count} ${count === 1 ? 'person' : 'people'}.` : '')});
    }
    if (action === 'hide') {
      if (!organizer) return json({error: 'Only organizers can hide events.'}, 403);
      await run('UPDATE events SET hidden=? WHERE id=?', !!input.hidden, e.id).run();
      return json({ok: true});
    }
    if (action === 'slot-add') {
      const s = readSlot(input, e);
      if (s.error) return done(s);
      const position = (await run('SELECT COALESCE(MAX(position),0)::integer AS p FROM slots WHERE event=?', e.id).first()).p + 1;
      await run('INSERT INTO slots (id,event,label,starts_at,duration,capacity,position) VALUES (?,?,?,?,?,?,?)',
        crypto.randomUUID(), e.id, s.label, s.start?.toISOString() ?? null, s.duration, s.capacity, position).run();
      return json({ok: true});
    }
    if (action === 'slot-delete' || action === 'remove-claim') {
      const slot = uuid(input.slot) && await run('SELECT id FROM slots WHERE id=? AND event=?', input.slot, e.id).first();
      if (!slot) return json({error: 'That slot is gone.'}, 404);
      if (action === 'slot-delete') await run('DELETE FROM slots WHERE id=?', slot.id).run();
      else await unclaimSlot(db, clean(input.member, 64), slot.id);
      return json({ok: true});
    }
    if (action === 'announce' || action === 'help') {
      if (!organizer) return json({error: 'Only organizers can email everyone.'}, 403);
      if (!mailer) return json({error: 'Email is not set up yet.'}, 409);
      const list = action === 'help'
        ? await recipients(db, `AND NOT EXISTS (SELECT 1 FROM claims c JOIN slots s ON s.id=c.slot WHERE s.event=? AND c.member=m.id) ${await audience(db, 'events', 'signups')}`, e.id)
        : undefined;
      if (action === 'help' && !(await slotsFor(db, e.id)).some(s => s.taken < s.capacity)) return json({ok: true, notice: 'Every slot is filled.'});
      const count = await announce(db, mailer, base, e, action === 'help' ? 'help' : 'new', list);
      if (action === 'announce') await run('UPDATE events SET announced=true WHERE id=?', e.id).run();
      if (count) queued = true;
      return json({ok: true, notice: count ? `Sending to ${count} ${count === 1 ? 'person' : 'people'}.` : 'Nobody to email.'});
    }
    return json({error: 'This action is unavailable.'}, 404);
  }
}
