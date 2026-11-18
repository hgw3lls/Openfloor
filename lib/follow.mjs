// Follow-through: action items, reminders, carrying topics over, the record
// of decisions, and each member's calendar feed.
import {actionEmail} from './email.mjs';
import {enqueue} from './outbox.mjs';
import {replyFor} from './notify.mjs';
import {localValue} from './schedule.mjs';

const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const fail = (error, status = 400) => ({error, status});
const DAY = 86400000;
const label = r => r?.name || r?.email?.split('@')[0] || '';

export async function listActions(db, where, ...args) {
  return (await db.prepare(`SELECT a.*,m.name,m.email,mt.title AS meeting_title FROM actions a
    LEFT JOIN members m ON m.id=a.owner JOIN meetings mt ON mt.id=a.meeting WHERE ${where}
    ORDER BY a.status='done', a.due='' , a.due, a.created`).bind(...args).all()).results
    .map(a => ({id: a.id, meeting: a.meeting, meetingTitle: a.meeting_title, title: a.title, owner: a.owner, ownerName: a.owner ? label(a) : '',
      due: a.due, status: a.status, doneAt: Number(a.done_at)}));
}

async function owner(db, id) {
  if (!id) return null;
  return db.prepare("SELECT id,email,name,token,emails FROM members WHERE id=? AND status='active'").bind(id).first();
}

async function notifyOwner(db, mailer, base, action, kind, now) {
  if (!mailer || !base) return 0;
  const sub = await owner(db, action.owner);
  if (!sub || sub.emails === 'none') return 0;
  const meeting = await db.prepare('SELECT * FROM meetings WHERE id=?').bind(action.meeting).first();
  return enqueue(db, meeting.id, [actionEmail({sub, base, action, meeting, kind, replyTo: await replyFor(db, sub, 'action', action.id)})], now);
}

export async function addAction(db, meetingId, input, {mailer, base, now = Date.now()} = {}) {
  const title = clean(input.title, 200), due = clean(input.due, 10), ownerId = clean(input.owner, 64);
  if (!title) return fail('Say what needs to be done.');
  if (due && !validDate(due)) return fail('Choose a valid due date.');
  if (ownerId && !await owner(db, ownerId)) return fail('Choose a member as the owner.');
  const action = {id: crypto.randomUUID(), meeting: meetingId, title, owner: ownerId || null, due};
  await db.prepare('INSERT INTO actions (id,meeting,title,owner,due,created) VALUES (?,?,?,?,?,?)')
    .bind(action.id, meetingId, title, action.owner, due, now).run();
  const queued = action.owner ? await notifyOwner(db, mailer, base, action, 'assigned', now) : 0;
  return {ok: true, id: action.id, queued};
}

export async function updateAction(db, id, input, {mailer, base, now = Date.now()} = {}) {
  const current = await db.prepare('SELECT * FROM actions WHERE id=?').bind(id).first();
  if (!current) return fail('Action item not found.', 404);
  const title = input.title === undefined ? current.title : clean(input.title, 200);
  const due = input.due === undefined ? current.due : clean(input.due, 10);
  const ownerId = input.owner === undefined ? current.owner : (clean(input.owner, 64) || null);
  if (!title) return fail('Say what needs to be done.');
  if (due && !validDate(due)) return fail('Choose a valid due date.');
  if (ownerId && ownerId !== current.owner && !await owner(db, ownerId)) return fail('Choose a member as the owner.');
  const reminded = due !== current.due ? '' : current.reminded;
  await db.prepare('UPDATE actions SET title=?,due=?,owner=?,reminded=? WHERE id=?').bind(title, due, ownerId, reminded, id).run();
  const queued = ownerId && ownerId !== current.owner ? await notifyOwner(db, mailer, base, {...current, title, due, owner: ownerId}, 'assigned', now) : 0;
  return {ok: true, queued};
}

// Owners can mark their own items done; organizers can mark any.
export async function setDone(db, id, done, {memberId, organizer = false, now = Date.now()} = {}) {
  const action = await db.prepare('SELECT id,owner FROM actions WHERE id=?').bind(id).first();
  if (!action) return fail('Action item not found.', 404);
  if (!organizer && action.owner !== memberId) return fail('Only the owner or an organizer can change this.', 403);
  await db.prepare('UPDATE actions SET status=?, done_at=? WHERE id=?').bind(done ? 'done' : 'open', done ? now : 0, id).run();
  return {ok: true};
}

// Moves topics that didn't make the agenda to another meeting (once).
export async function carryOver(db, fromId, toId, now = Date.now()) {
  const from = await db.prepare('SELECT * FROM meetings WHERE id=?').bind(fromId).first();
  const to = await db.prepare('SELECT * FROM meetings WHERE id=?').bind(toId).first();
  if (!from || !to || from.id === to.id) return fail('Choose another meeting.', 404);
  if (to.phase !== 'collect') return fail('That meeting isn’t taking topics.', 409);
  const used = new Set(JSON.parse(from.agenda || '[]').map(a => a.label.trim().toLowerCase()));
  const topics = (await db.prepare('SELECT * FROM topics WHERE meeting=? AND hidden=false AND carried_from=? ORDER BY created').bind(fromId, '').all()).results
    .filter(t => !used.has(t.label.trim().toLowerCase()));
  const already = new Set((await db.prepare('SELECT carried_from FROM topics WHERE meeting=?').bind(toId).all()).results.map(t => t.carried_from));
  let moved = 0;
  for (const t of topics) {
    if (already.has(t.id)) continue;
    await db.prepare(`INSERT INTO topics (id,meeting,label,detail,kind,created,announced,author,carried_from) VALUES (?,?,?,?,?,?,true,?,?)`)
      .bind(crypto.randomUUID(), toId, t.label, t.detail, t.kind, now, t.author, t.id).run();
    moved++;
  }
  return {ok: true, moved};
}

// Daily: due-soon, due-today and overdue reminders, each sent once.
export async function remindActions(db, mailer, base, now = Date.now()) {
  if (!mailer || !base) return 0;
  const open = (await db.prepare(`SELECT a.*,mt.timezone FROM actions a JOIN meetings mt ON mt.id=a.meeting
    WHERE a.status='open' AND a.due<>'' AND a.owner IS NOT NULL AND a.reminded<>'overdue'`).bind().all()).results;
  let sent = 0;
  for (const a of open) {
    const today = localValue(new Date(now), a.timezone || 'UTC').slice(0, 10);
    const days = Math.round((Date.parse(a.due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
    const stage = days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 2 ? 'soon' : '';
    const order = ['', 'soon', 'today', 'overdue'];
    if (!stage || order.indexOf(stage) <= order.indexOf(a.reminded)) continue;
    sent += await notifyOwner(db, mailer, base, a, stage, now);
    await db.prepare('UPDATE actions SET reminded=? WHERE id=?').bind(stage, a.id).run();
  }
  return sent;
}

// The record: past meetings with agenda, decisions and action items.
export async function decisions(db, now = Date.now()) {
  const meetings = (await db.prepare(`SELECT id,title,starts_at,timezone,schedule,agenda,notes FROM meetings
    WHERE (starts_at IS NOT NULL AND starts_at < ?) OR notes<>'' OR agenda<>'[]' ORDER BY starts_at DESC NULLS LAST, created DESC LIMIT 200`)
    .bind(new Date(now).toISOString()).all()).results;
  const actions = await listActions(db, 'a.meeting IN (SELECT id FROM meetings)');
  return meetings.map(m => ({id: m.id, title: m.title, startsAt: m.starts_at ? new Date(m.starts_at).toISOString() : null, timezone: m.timezone,
    schedule: m.schedule, agenda: JSON.parse(m.agenda || '[]'), notes: m.notes, actions: actions.filter(a => a.meeting === m.id)}));
}
