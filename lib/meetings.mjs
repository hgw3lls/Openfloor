import {timingSafeEqual} from 'node:crypto';
import {currentMember} from './auth.mjs';
import {agendaEmail, appBase, meetingEmail, outcomesEmail, topicsEmail} from './email.mjs';
import {allow} from './limits.mjs';
import {markSent, notify, recipients} from './notify.mjs';
import {flush} from './outbox.mjs';
import {formatWhen, localValue, validZone, zonedToUtc} from './schedule.mjs';

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const key = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const kinds = ['Discussion', 'Decision', 'Update'];
export const repeats = ['', 'weekly', 'biweekly', 'monthly'];
const HOUR = 3600000;
const sameSecret = (supplied, expected) => {
  const a = Buffer.from(supplied ?? ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Reads the date/time fields organizers fill in (create and schedule forms).
function scheduleInput(input) {
  const timezone = clean(input.timezone, 64) || 'UTC';
  if (!validZone(timezone)) return {error: 'Choose a valid time zone.'};
  const local = clean(input.local, 16);
  const start = local ? zonedToUtc(local, timezone) : null;
  if (local && !start) return {error: 'Enter a valid date and time.'};
  return {timezone, start, duration: Math.max(5, Math.min(600, Number.parseInt(input.duration, 10) || 60)),
    location: clean(input.location, 200), schedule: clean(input.schedule, 120), repeat: repeats.includes(input.repeat) ? input.repeat : ''};
}

// defer(promise) keeps work running after the response is sent (Vercel's
// waitUntil). Queued emails are sent that way, so nobody waits on Gmail.
export async function meetings(request, db, organizerKey, mailer = null, defer = null, now = Date.now()) {
  let queued = false;
  const deliver = async task => {
    try { const count = await task(); if (count) queued = true; return count ? `Sending to ${count} ${count === 1 ? 'person' : 'people'}.` : ''; }
    catch (error) { console.error('Email failed', error.code ?? error.name); return 'Saved, but the email could not be queued.'; }
  };
  const response = await handle();
  if (queued && mailer && defer) defer(flush(db, mailer).catch(error => console.error('Outbox flush failed', error.code ?? error.name)));
  return response;

  async function handle() {
    const url = new URL(request.url);
    const base = appBase(request);
    const id = url.searchParams.get('meeting') || '';
    const action = url.searchParams.get('action') || '';
    const run = (sql, ...args) => db.prepare(sql).bind(...args);
    const write = request.method === 'POST';
    if (write && (request.headers.get('Origin') !== url.origin ||
        !request.headers.get('Content-Type')?.startsWith('application/json'))) return json({error: 'Invalid request.'}, 403);
    let input = {};
    if (write) {
      const raw = await request.text();
      if (raw.length > 22000) return json({error: 'This entry is too long.'}, 413);
      try { input = JSON.parse(raw) ?? {}; } catch { return json({error: 'Invalid entry.'}, 400); }
    } else if (request.method !== 'GET') return json({error: 'Method unavailable.'}, 405);
    if (input.website) return json({ok: true}); // spam trap: bots fill hidden fields

    const me = await currentMember(request, db, now);
    const organizer = me?.role === 'organizer';

    if (!id && !action && write) {
      if (!organizer) return json({error: 'Only organizers can create meetings. Sign in first.'}, 403);
      const title = clean(input.title, 100);
      if (!title) return json({error: 'Enter a meeting name.'}, 400);
      const s = scheduleInput(input);
      if (s.error) return json({error: s.error}, 400);
      const meeting = crypto.randomUUID();
      await run('INSERT INTO meetings (id,secret,title,schedule,starts_at,timezone,duration,location,repeat,created) VALUES (?,?,?,?,?,?,?,?,?,?)',
        meeting, crypto.randomUUID(), title, s.schedule, s.start?.toISOString() ?? null, s.timezone, s.duration, s.location, s.repeat, now).run();
      let notice = '';
      if (input.announce !== false && mailer) {
        const created = await run('SELECT * FROM meetings WHERE id=?', meeting).first();
        notice = await deliver(() => notify(db, mailer, created, sub => meetingEmail({meeting: created, sub, base, kind: 'new'})));
        await markSent(db, created, {announced: true});
      }
      return json({id: meeting, notice}, 201);
    }
    if (!key(id)) return json({error: 'Meeting not found.'}, 404);
    const meeting = await run('SELECT * FROM meetings WHERE id=?', id).first();
    if (!meeting) return json({error: 'Meeting not found.'}, 404);
    // Organizers, plus anyone holding a pre-member organizer link for this meeting.
    const admin = organizer || sameSecret(request.headers.get('Authorization'), 'Bearer ' + meeting.secret);
    const ballotId = me ? 'm:' + me.id : null;
    const phase = meeting.phase;
    const sent = JSON.parse(meeting.sent || '{}');

    if (!write) {
      const list = (await run(`SELECT t.id,t.label,t.detail,t.kind,t.hidden,(t.author=?) AS own,
        COUNT(b.voter) FILTER (WHERE b.value>0)::integer AS up,
        COUNT(b.voter) FILTER (WHERE b.value<0)::integer AS down,
        COALESCE(MAX(b.value) FILTER (WHERE b.voter=?),0)::integer AS mine
        FROM topics t LEFT JOIN ballots b ON b.topic=t.id WHERE t.meeting=? AND (t.hidden=false OR ?)
        GROUP BY t.id ORDER BY COALESCE(SUM(b.value),0) DESC, t.created ASC`, ballotId ?? '', ballotId ?? '', id, admin).all()).results;
      const showCounts = admin || phase === 'agenda';
      const topics = list.map(t => ({...t, votes: t.up - t.down, ...(showCounts ? {} : {up: null, down: null, votes: null})}));
      const start = meeting.starts_at ? new Date(meeting.starts_at) : null;
      const rsvps = (await run(`SELECT r.status,r.reason,m.id,m.name,m.email FROM rsvps r JOIN members m ON m.id=r.member
        WHERE r.meeting=? AND m.status='active' ORDER BY lower(m.name), m.email`, id).all()).results;
      const label = r => r.name || r.email.split('@')[0];
      const mine = me ? rsvps.find(r => r.id === me.id) : null;
      const data = {id, title: meeting.title, schedule: meeting.schedule, phase, admin, topics,
        agenda: JSON.parse(meeting.agenda), notes: meeting.notes, appUrl: base, repeat: meeting.repeat,
        startsAt: start?.toISOString() ?? null, timezone: meeting.timezone, duration: meeting.duration, location: meeting.location,
        when: start ? formatWhen(start, meeting.timezone) : '', local: start ? localValue(start, meeting.timezone) : '',
        past: !!start && start.getTime() + meeting.duration * 60000 < now,
        me: me ? {id: me.id, name: me.name, role: me.role} : null,
        rsvp: mine ? {status: mine.status, reason: mine.reason} : null,
        attendance: {going: rsvps.filter(r => r.status === 'yes').map(label), maybe: rsvps.filter(r => r.status === 'maybe').map(label)}};
      if (admin) {
        data.attendance.declined = rsvps.filter(r => r.status === 'no').map(r => ({name: label(r), reason: r.reason}));
        data.attendance.noAnswer = (await run(`SELECT name,email FROM members m WHERE status='active'
          AND NOT EXISTS (SELECT 1 FROM rsvps r WHERE r.meeting=? AND r.member=m.id) ORDER BY lower(name), email`, id).all()).results.map(label);
        data.sent = sent;
      }
      return json(data);
    }

    if (['topic', 'vote', 'rsvp'].includes(action) && !me) return json({error: 'Sign in to take part.'}, 401);

    if (action === 'topic') {
      if (!await allow(db, 'topic:' + id + ':' + me.id, 20, HOUR, now)) return json({error: 'Too many topics. Try again in an hour.'}, 429);
      const label = clean(input.label, 120);
      if (!label) return json({error: 'Enter a topic.'}, 400);
      const kind = kinds.includes(input.kind) ? input.kind : 'Discussion';
      const result = await run(`INSERT INTO topics (id,meeting,label,detail,kind,created,announced,author) SELECT ?,id,?,?,?,?,false,? FROM meetings WHERE id=? AND phase='collect'`,
        crypto.randomUUID(), label, clean(input.detail, 650), kind, now, ballotId, id).run();
      if (!result.meta.changes) return json({error: 'Topic submissions are closed.'}, 409);
    } else if (action === 'vote') {
      const value = Number(input.value);
      if (!key(input.topic) || ![1, 0, -1].includes(value)) return json({error: 'Invalid vote.'}, 400);
      if (phase === 'agenda') return json({error: 'Voting is closed.'}, 409);
      const topic = await run('SELECT id,author FROM topics WHERE id=? AND meeting=? AND hidden=false', input.topic, id).first();
      if (!topic) return json({error: 'That topic is unavailable.'}, 409);
      if (topic.author === ballotId) return json({error: 'You can’t vote on your own topic.'}, 403);
      if (value === 0) await run('DELETE FROM ballots WHERE topic=? AND voter=?', input.topic, ballotId).run();
      else await run(`INSERT INTO ballots (topic,meeting,voter,value) VALUES (?,?,?,?)
        ON CONFLICT (topic,voter) DO UPDATE SET value=excluded.value`, input.topic, id, ballotId, value).run();
    } else if (action === 'rsvp') {
      const status = ['yes', 'maybe', 'no'].includes(input.status) ? input.status : null;
      if (!status) return json({error: 'Choose Going, Maybe or Can’t make it.'}, 400);
      const reason = clean(input.reason, 500);
      if (status === 'no' && reason.length < 3) return json({error: 'Please say why you can’t make it.'}, 400);
      await run(`INSERT INTO rsvps (meeting,member,status,reason,updated) VALUES (?,?,?,?,?)
        ON CONFLICT (meeting,member) DO UPDATE SET status=excluded.status, reason=excluded.reason, updated=excluded.updated`,
        id, me.id, status, status === 'yes' ? '' : reason, now).run();
    } else if (!admin) {
      return json({error: 'This action is unavailable.'}, 403);
    } else if (['topic-edit', 'topic-hide', 'topic-delete'].includes(action)) {
      if (!key(input.topic)) return json({error: 'Invalid topic.'}, 400);
      const topic = await run('SELECT id FROM topics WHERE id=? AND meeting=?', input.topic, id).first();
      if (!topic) return json({error: 'That topic is unavailable.'}, 404);
      if (action === 'topic-edit') {
        const label = clean(input.label, 120);
        if (!label) return json({error: 'Enter a topic.'}, 400);
        await run('UPDATE topics SET label=?,detail=?,kind=? WHERE id=?', label, clean(input.detail, 650),
          kinds.includes(input.kind) ? input.kind : 'Discussion', topic.id).run();
      } else if (action === 'topic-hide') {
        await run('UPDATE topics SET hidden=? WHERE id=?', !!input.hidden, topic.id).run();
      } else {
        await run('DELETE FROM ballots WHERE topic=?', topic.id).run();
        await run('DELETE FROM topics WHERE id=?', topic.id).run();
      }
    } else if (action === 'schedule') {
      const s = scheduleInput(input);
      if (s.error) return json({error: s.error}, 400);
      const title = clean(input.title, 100) || meeting.title;
      const previous = meeting.starts_at ? new Date(meeting.starts_at).toISOString() : null;
      await run('UPDATE meetings SET title=?,starts_at=?,timezone=?,duration=?,location=?,schedule=?,repeat=? WHERE id=?',
        title, s.start?.toISOString() ?? null, s.timezone, s.duration, s.location, s.schedule, s.repeat, id).run();
      const changed = s.start && s.start.toISOString() !== previous;
      let notice = '';
      if (mailer && s.start && (!sent.announced || (changed && input.notify))) {
        const updated = await run('SELECT * FROM meetings WHERE id=?', id).first();
        const kind = sent.announced ? 'schedule' : 'new';
        notice = await deliver(() => notify(db, mailer, updated, sub => meetingEmail({meeting: updated, sub, base, kind})));
        await markSent(db, updated, {announced: true});
      }
      return json({ok: true, notice});
    } else if (action === 'nudge') {
      if (!mailer) return json({error: 'Email is not set up yet.'}, 409);
      const list = await recipients(db, 'AND NOT EXISTS (SELECT 1 FROM rsvps r WHERE r.meeting=? AND r.member=m.id)', id);
      if (!list.length) return json({ok: true, notice: 'Everyone getting email has answered.'});
      const notice = await deliver(() => notify(db, mailer, meeting, sub => meetingEmail({meeting, sub, base, kind: 'nudge'}), list));
      return json({ok: true, notice});
    } else if (action === 'phase') {
      if (!['collect', 'vote'].includes(input.phase)) return json({error: 'Invalid phase.'}, 400);
      await run('UPDATE meetings SET phase=? WHERE id=?', input.phase, id).run();
      let notice = '';
      if (input.phase === 'vote' && !sent.vote && mailer) {
        const topics = (await run('SELECT id,label,detail,kind,author FROM topics WHERE meeting=? AND hidden=false ORDER BY created', id).all()).results;
        if (topics.length) {
          notice = await deliver(() => notify(db, mailer, meeting, sub => topicsEmail({meeting, sub, base, topics,
            subject: 'Vote on the topics: ' + meeting.title, intro: 'Topic submissions are closed. Vote on what we should spend time on:'})));
          await run('UPDATE topics SET announced=true WHERE meeting=? AND hidden=false', id).run();
          await markSent(db, meeting, {vote: true});
        }
      }
      return json({ok: true, notice});
    } else if (action === 'agenda') {
      const agenda = Array.isArray(input.agenda) ? input.agenda.slice(0, 15).map(item => ({
        label: clean(item?.label, 120), detail: clean(item?.detail, 650),
        kind: kinds.includes(item?.kind) ? item.kind : 'Discussion',
        minutes: Math.max(1, Math.min(120, Number.parseInt(item?.minutes, 10) || 10))
      })).filter(item => item.label) : [];
      if (!agenda.length) return json({error: 'Add at least one agenda item.'}, 400);
      await run("UPDATE meetings SET agenda=?,phase='agenda' WHERE id=?", JSON.stringify(agenda), id).run();
      let notice = '';
      if (!sent.agenda && mailer) {
        const updated = await run('SELECT * FROM meetings WHERE id=?', id).first();
        notice = await deliver(() => notify(db, mailer, updated, sub => agendaEmail({meeting: updated, sub, base, kind: 'agenda'})));
        await markSent(db, updated, {agenda: true});
      }
      return json({ok: true, notice});
    } else if (action === 'notes') {
      await run('UPDATE meetings SET notes=? WHERE id=?', clean(input.notes, 7000), id).run();
    } else if (action === 'email') {
      if (!mailer) return json({error: 'Email is not set up yet.'}, 409);
      if (!['agenda', 'outcomes'].includes(input.kind)) return json({error: 'Invalid email.'}, 400);
      if (input.kind === 'outcomes' && !meeting.notes) return json({error: 'Save the outcomes first.'}, 400);
      if (input.kind === 'agenda' && meeting.agenda === '[]') return json({error: 'Publish the agenda first.'}, 400);
      const notice = await deliver(() => notify(db, mailer, meeting, sub => input.kind === 'outcomes'
        ? outcomesEmail({meeting, sub, base}) : agendaEmail({meeting, sub, base, kind: 'agenda'})));
      return json({ok: true, notice: notice || 'No members are getting email yet.'});
    } else return json({error: 'This action is unavailable.'}, 404);
    return json({ok: true});
  }
}
