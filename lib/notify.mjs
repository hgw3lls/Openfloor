// Queuing email to a meeting's list. Messages go to the outbox and are sent
// in the background (see outbox.mjs).
import {confirmEmail} from './email.mjs';
import {budgetLeft, enqueue} from './outbox.mjs';

export const emailPattern = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export async function activeSubscribers(db, meetingId) {
  return (await db.prepare("SELECT id,email,token,voter FROM subscribers WHERE meeting=? AND status='active'").bind(meetingId).all()).results;
}

// Queues one message per active subscriber. Returns the count.
export async function notify(db, mailer, meeting, build) {
  if (!mailer) return 0;
  const list = await activeSubscribers(db, meeting.id);
  return enqueue(db, meeting.id, list.map(sub => build(sub)));
}

// Adds (or re-invites) an address and queues the confirmation email. A given
// address gets at most one confirmation email per day per meeting.
// Returns 'active', 'pending', 'invited' or 'budget' (daily email limit reached).
export async function subscribe(db, mailer, base, meeting, email, voter = '') {
  const day = 86400000, now = Date.now();
  const existing = await db.prepare('SELECT * FROM subscribers WHERE meeting=? AND email=?').bind(meeting.id, email).first();
  if (existing?.status === 'active') return 'active';
  if (existing && now - Number(existing.invited) < day) return 'pending';
  if (await budgetLeft(db, now) <= 0) return 'budget';
  let sub = existing;
  if (sub) {
    await db.prepare("UPDATE subscribers SET status='pending',invited=?,voter=CASE WHEN voter='' THEN ? ELSE voter END WHERE id=?").bind(now, voter, sub.id).run();
  } else {
    sub = {id: crypto.randomUUID(), email, token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')};
    await db.prepare("INSERT INTO subscribers (id,meeting,email,token,status,invited,voter) VALUES (?,?,?,?,'pending',?,?) ON CONFLICT (meeting,email) DO NOTHING")
      .bind(sub.id, meeting.id, email, sub.token, now, voter).run();
  }
  await enqueue(db, meeting.id, [confirmEmail({meeting, sub, base})], now);
  return 'invited';
}

export async function markSent(db, meeting, changes) {
  const sent = {...JSON.parse(meeting.sent || '{}'), ...changes};
  await db.prepare('UPDATE meetings SET sent=? WHERE id=?').bind(JSON.stringify(sent), meeting.id).run();
  meeting.sent = JSON.stringify(sent);
}
