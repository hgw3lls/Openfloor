import {timingSafeEqual} from 'node:crypto';
import {currentMember} from './auth.mjs';
import {agendaEmail, appBase, cancelledEmail, meetingEmail, outcomesEmail, topicsEmail} from './email.mjs';
import {allow} from './limits.mjs';
import {markSent, notify, recipients, replyFor, withReplies} from './notify.mjs';
import {castVote, setRsvp, addTopic} from './actions.mjs';
import {addAction, carryOver, listActions, setDone, updateAction} from './follow.mjs';
import {flush} from './outbox.mjs';
import {getFeatures, levelFor} from './features.mjs';
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

// Removes a meeting and everything that belongs to it. A repeating series
// keeps its pointer to the deleted meeting, so the daily job won't recreate it.
export async function deleteMeeting(db, id) {
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const topics = "SELECT id FROM topics WHERE meeting=?", actions = "SELECT id FROM actions WHERE meeting=?";
  await run('DELETE FROM ballots WHERE meeting=?', id);
  await run(`DELETE FROM comments WHERE (kind='meeting' AND target=?) OR (kind='topic' AND target IN (${topics}))`, id, id);
  await run(`DELETE FROM reply_keys WHERE (kind='meeting' AND target=?) OR (kind='topic' AND target IN (${topics})) OR (kind='action' AND target IN (${actions}))`, id, id, id);
  await run('DELETE FROM topics WHERE meeting=?', id);
  await run('DELETE FROM votes WHERE meeting=?', id);
  await run('DELETE FROM subscribers WHERE meeting=?', id);
  await run("DELETE FROM outbox WHERE meeting=? AND status IN ('queued','failed')", id);
  await run('DELETE FROM meetings WHERE id=?', id);
}

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
        notice = await deliver(() => notify(db, mailer, created, async sub => meetingEmail({meeting: created, sub, base, kind: 'new', replyTo: await replyFor(db, sub, 'meeting', created.id)})));
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
      const features = await getFeatures(db), level = key => admin ? 'full' : levelFor(features, me?.role, key);
      const list = level('topics') === 'off' ? [] : (await run(`SELECT t.id,t.label,t.detail,t.kind,t.hidden,(t.carried_from<>'') AS carried,(t.author=?) AS own,
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
      data.actions = (await listActions(db, 'a.meeting=?', id)).map(a => ({...a, mine: !!me && a.owner === me.id}));
      data.carried = (await run("SELECT COUNT(*)::integer AS n FROM topics WHERE meeting=? AND carried_from<>''", id).first()).n;
      for (const t of data.topics) t.carried = !!list.find(x => x.id === t.id)?.carried;
      if (me && level('comments') !== 'off') {
        const comments = (await run(`SELECT c.id,c.kind,c.target,c.body,c.via,c.created,c.author,m.name,m.email FROM comments c JOIN members m ON m.id=c.author
          WHERE c.hidden=false AND ((c.kind='meeting' AND c.target=?) OR (c.kind='topic' AND c.target IN (SELECT id FROM topics WHERE meeting=?))) ORDER BY c.created`, id, id).all()).results
          .map(c => ({id: c.id, kind: c.kind, target: c.target, body: c.body, via: c.via, created: Number(c.created), author: label(c), mine: c.author === me.id}));
        data.discussion = comments.filter(c => c.kind === 'meeting');
        for (const t of data.topics) t.comments = comments.filter(c => c.kind === 'topic' && c.target === t.id);
      }
      if (admin) {
        data.attendance.declined = rsvps.filter(r => r.status === 'no').map(r => ({name: label(r), reason: r.reason}));
        data.attendance.noAnswer = (await run(`SELECT name,email FROM members m WHERE status='active'
          AND NOT EXISTS (SELECT 1 FROM rsvps r WHERE r.meeting=? AND r.member=m.id) ORDER BY lower(name), email`, id).all()).results.map(label);
        data.sent = sent;
        data.memberOptions = (await run("SELECT id,name,email FROM members WHERE status='active' ORDER BY lower(name), email").all()).results.map(m => ({id: m.id, name: label(m)}));
        data.openActions = await listActions(db, "a.status='open' AND a.meeting<>?", id);
        data.otherMeetings = (await run(`SELECT id,title,starts_at,timezone FROM meetings WHERE id<>? AND phase='collect' AND (starts_at IS NULL OR starts_at > ?) ORDER BY starts_at NULLS LAST`, id, new Date(now).toISOString()).all()).results
          .map(m => ({id: m.id, title: m.title, when: m.starts_at ? formatWhen(new Date(m.starts_at), m.timezone) : ''}));
      }
      return json(data);
    }

    if (['topic', 'vote', 'rsvp', 'action-done'].includes(action) && !me && !admin) return json({error: 'Sign in to take part.'}, 401);
    if (action === 'action-done') {
      const owned = key(input.action) && await run('SELECT id FROM actions WHERE id=? AND meeting=?', input.action, id).first();
      if (!owned) return json({error: 'Action item not found.'}, 404);
      const result = await setDone(db, input.action, !!input.done, {memberId: me?.id, organizer: admin, now});
      return result.error ? json({error: result.error}, result.status) : json({ok: true});
    }

    if (action === 'topic' && !await allow(db, 'topic:' + id + ':' + me.id, 20, HOUR, now)) return json({error: 'Too many topics. Try again in an hour.'}, 429);
    if (['topic', 'vote', 'rsvp'].includes(action)) {
      const result = action === 'topic' ? await addTopic(db, me.id, id, input, now)
        : action === 'vote' ? (key(input.topic) ? await castVote(db, me.id, input.topic, Number(input.value)) : {error: 'Invalid vote.', status: 400})
        : await setRsvp(db, me.id, id, input.status, input.reason, now);
      if (result.error) return json({error: result.error}, result.status);
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
        notice = await deliver(() => notify(db, mailer, updated, async sub => meetingEmail({meeting: updated, sub, base, kind, replyTo: await replyFor(db, sub, 'meeting', id)})));
        await markSent(db, updated, {announced: true});
      }
      return json({ok: true, notice});
    } else if (action === 'nudge') {
      if (!mailer) return json({error: 'Email is not set up yet.'}, 409);
      const list = await recipients(db, 'AND m.notify_meetings AND NOT EXISTS (SELECT 1 FROM rsvps r WHERE r.meeting=? AND r.member=m.id)', id);
      if (!list.length) return json({ok: true, notice: 'Everyone getting email has answered.'});
      const notice = await deliver(() => notify(db, mailer, meeting, async sub => meetingEmail({meeting, sub, base, kind: 'nudge', replyTo: await replyFor(db, sub, 'meeting', id)}), list));
      return json({ok: true, notice});
    } else if (action === 'phase') {
      if (!['collect', 'vote'].includes(input.phase)) return json({error: 'Invalid phase.'}, 400);
      await run('UPDATE meetings SET phase=? WHERE id=?', input.phase, id).run();
      let notice = '';
      if (input.phase === 'vote' && !sent.vote && mailer) {
        const topics = (await run('SELECT id,label,detail,kind,author FROM topics WHERE meeting=? AND hidden=false ORDER BY created', id).all()).results;
        if (topics.length) {
          // Members only get the voting email when they can vote.
          const voters = (await getFeatures(db)).topics === 'full' ? undefined : await recipients(db, "AND role='organizer'");
          notice = await deliver(() => notify(db, mailer, meeting, async sub => topicsEmail({meeting, sub, base, topics: await withReplies(db, sub, topics), replyTo: await replyFor(db, sub, 'meeting', id),
            subject: 'Vote on the topics: ' + meeting.title, intro: 'Topic submissions are closed. Vote on what we should spend time on:'}), voters));
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
        notice = await deliver(() => notify(db, mailer, updated, async sub => agendaEmail({meeting: updated, sub, base, kind: 'agenda', replyTo: await replyFor(db, sub, 'meeting', id)})));
        await markSent(db, updated, {agenda: true});
      }
      return json({ok: true, notice});
    } else if (action === 'action-add') {
      const result = await addAction(db, id, input, {mailer, base, now});
      if (result.error) return json({error: result.error}, result.status);
      if (result.queued) queued = true;
      return json({ok: true, notice: result.queued ? 'Emailed the owner.' : ''});
    } else if (action === 'action-update' || action === 'action-delete') {
      const owned = key(input.action) && await run('SELECT id FROM actions WHERE id=? AND meeting=?', input.action, id).first();
      if (!owned) return json({error: 'Action item not found.'}, 404);
      if (action === 'action-delete') { await run('DELETE FROM actions WHERE id=?', input.action).run(); return json({ok: true}); }
      const result = await updateAction(db, input.action, input, {mailer, base, now});
      if (result.error) return json({error: result.error}, result.status);
      if (result.queued) queued = true;
      return json({ok: true, notice: result.queued ? 'Emailed the new owner.' : ''});
    } else if (action === 'carry') {
      if (!key(input.to)) return json({error: 'Choose a meeting.'}, 400);
      const result = await carryOver(db, id, input.to, now);
      if (result.error) return json({error: result.error}, result.status);
      return json({ok: true, notice: result.moved ? `Moved ${result.moved} ${result.moved === 1 ? 'topic' : 'topics'}.` : 'No topics left to move.'});
    } else if (action === 'delete') {
      if (!organizer) return json({error: 'Only organizers can delete meetings.'}, 403);
      const upcoming = !meeting.starts_at || new Date(meeting.starts_at).getTime() + meeting.duration * 60000 > now;
      let notice = '';
      if (input.notify && upcoming && sent.announced && mailer) {
        // Queued without the meeting's id, so deleting its pending emails keeps this one.
        notice = await deliver(() => notify(db, mailer, {id: ''}, sub => cancelledEmail({meeting, sub, base})));
      }
      await deleteMeeting(db, id);
      return json({ok: true, notice: ['Meeting deleted.', notice].filter(Boolean).join(' ')});
    } else if (action === 'notes') {
      await run('UPDATE meetings SET notes=? WHERE id=?', clean(input.notes, 7000), id).run();
    } else if (action === 'email') {
      if (!mailer) return json({error: 'Email is not set up yet.'}, 409);
      if (!['agenda', 'outcomes'].includes(input.kind)) return json({error: 'Invalid email.'}, 400);
      const actions = await listActions(db, 'a.meeting=?', id);
      if (input.kind === 'outcomes' && !meeting.notes && !actions.length) return json({error: 'Save the outcomes or add action items first.'}, 400);
      if (input.kind === 'agenda' && meeting.agenda === '[]') return json({error: 'Publish the agenda first.'}, 400);
      const notice = await deliver(() => notify(db, mailer, meeting, async sub => input.kind === 'outcomes'
        ? outcomesEmail({meeting, sub, base, actions, replyTo: await replyFor(db, sub, 'meeting', id)}) : agendaEmail({meeting, sub, base, kind: 'agenda', replyTo: await replyFor(db, sub, 'meeting', id)})));
      return json({ok: true, notice: notice || 'No members are getting email yet.'});
    } else return json({error: 'This action is unavailable.'}, 404);
    return json({ok: true});
  }
}
