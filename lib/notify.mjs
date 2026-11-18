// Sending to a meeting's email list.
import {confirmEmail} from './email.mjs';

export const emailPattern = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export async function activeSubscribers(db, meetingId) {
  return (await db.prepare("SELECT id,email,token FROM subscribers WHERE meeting=? AND status='active'").bind(meetingId).all()).results;
}

// Builds one message per active subscriber and sends them. Returns the count.
export async function notify(db, mailer, meeting, build) {
  if (!mailer) return 0;
  const list = await activeSubscribers(db, meeting.id);
  if (!list.length) return 0;
  return mailer.send(list.map(sub => build(sub)));
}

// Adds (or re-invites) an address and sends the confirmation email. A given
// address gets at most one confirmation email per day per meeting.
export async function subscribe(db, mailer, base, meeting, email) {
  const day = 86400000, now = Date.now();
  const existing = await db.prepare('SELECT * FROM subscribers WHERE meeting=? AND email=?').bind(meeting.id, email).first();
  if (existing?.status === 'active') return 'active';
  if (existing && now - Number(existing.invited) < day) return 'pending';
  let sub = existing;
  if (sub) {
    await db.prepare("UPDATE subscribers SET status='pending',invited=? WHERE id=?").bind(now, sub.id).run();
  } else {
    sub = {id: crypto.randomUUID(), email, token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')};
    await db.prepare("INSERT INTO subscribers (id,meeting,email,token,status,invited) VALUES (?,?,?,?,'pending',?) ON CONFLICT (meeting,email) DO NOTHING")
      .bind(sub.id, meeting.id, email, sub.token, now).run();
  }
  await mailer.send([confirmEmail({meeting, sub, base})]);
  return 'invited';
}

export async function markSent(db, meeting, changes) {
  const sent = {...JSON.parse(meeting.sent || '{}'), ...changes};
  await db.prepare('UPDATE meetings SET sent=? WHERE id=?').bind(JSON.stringify(sent), meeting.id).run();
  meeting.sent = JSON.stringify(sent);
}
