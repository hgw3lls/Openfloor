// Queuing email to the group's members. Messages go to the outbox and are
// sent in the background (see outbox.mjs).
import {enqueue} from './outbox.mjs';
import {inboundEnabled, replyAddress, replyKey} from './replies.mjs';

export const emailPattern = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

// Active members who want email. `voter` is how their votes are recorded.
export async function recipients(db, where = '', ...args) {
  return (await db.prepare(`SELECT id,email,name,token,'m:'||id AS voter FROM members m
    WHERE status='active' AND emails='all' ${where} ORDER BY email`).bind(...args).all()).results;
}

// Queues one message per member (default: every member who wants email).
export async function notify(db, mailer, meeting, build, list) {
  if (!mailer) return 0;
  list ??= await recipients(db);
  const messages = [];
  for (const sub of list) messages.push(await build(sub));
  return enqueue(db, meeting?.id ?? '', messages);
}

// Personal reply addresses (null when reading replies is off).
export async function replyFor(db, sub, kind, target) {
  return inboundEnabled() ? replyAddress(await replyKey(db, sub.id, kind, target)) : null;
}
export async function withReplies(db, sub, topics) {
  const out = [];
  for (const t of topics) out.push({...t, reply: await replyFor(db, sub, 'topic', t.id)});
  return out;
}

export async function markSent(db, meeting, changes) {
  const sent = {...JSON.parse(meeting.sent || '{}'), ...changes};
  await db.prepare('UPDATE meetings SET sent=? WHERE id=?').bind(JSON.stringify(sent), meeting.id).run();
  meeting.sent = JSON.stringify(sent);
}
