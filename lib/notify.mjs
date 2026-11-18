// Queuing email to the group's members. Messages go to the outbox and are
// sent in the background (see outbox.mjs).
import {enqueue} from './outbox.mjs';

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
  return enqueue(db, meeting?.id ?? '', list.map(sub => build(sub)));
}

export async function markSent(db, meeting, changes) {
  const sent = {...JSON.parse(meeting.sent || '{}'), ...changes};
  await db.prepare('UPDATE meetings SET sent=? WHERE id=?').bind(JSON.stringify(sent), meeting.id).run();
  meeting.sent = JSON.stringify(sent);
}
