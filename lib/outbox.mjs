// Email outbox. Messages are queued in the database, then sent in the
// background (after the response, and by the daily job). Failed sends are
// retried up to 5 times. A daily budget keeps Gmail under its sending limit:
// anything over the budget waits for the next run instead of being dropped.

import {getBranding, swapLogo} from './brand.mjs';

const DAY = 86400000, STUCK = 10 * 60000, MAX_ATTEMPTS = 5;

export const dailyLimit = (env = process.env) => Math.max(1, Number.parseInt(env.EMAIL_DAILY_LIMIT, 10) || 400);

export async function enqueue(db, meetingId, messages, now = Date.now()) {
  for (const m of messages) {
    await db.prepare('INSERT INTO outbox (id,meeting,recipient,message,created,updated) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), meetingId, m.to, JSON.stringify(m), now, now).run();
  }
  return messages.length;
}

export async function sentLastDay(db, now = Date.now()) {
  return (await db.prepare("SELECT COUNT(*)::integer AS n FROM outbox WHERE status='sent' AND updated > ?").bind(now - DAY).first()).n;
}

// How many more emails can be queued for sending today.
export async function budgetLeft(db, now = Date.now(), env = process.env) {
  const waiting = (await db.prepare("SELECT COUNT(*)::integer AS n FROM outbox WHERE status IN ('queued','sending') OR (status='failed' AND attempts < ?)")
    .bind(MAX_ATTEMPTS).first()).n;
  return dailyLimit(env) - (await sentLastDay(db, now)) - waiting;
}

export async function flush(db, mailer, {limit = 100, now = Date.now(), env = process.env, budgetMs = 40000} = {}) {
  const report = {sent: 0, failed: 0};
  if (!mailer) return report;
  // A message stuck in "sending" past its last try is given up on, not resent.
  await db.prepare("UPDATE outbox SET status='dead', error='stopped while sending' WHERE status='sending' AND updated < ? AND attempts >= ?")
    .bind(now - STUCK, MAX_ATTEMPTS).run();
  const room = Math.min(limit, dailyLimit(env) - await sentLastDay(db, now));
  if (room <= 0) return report;
  const rows = (await db.prepare(`UPDATE outbox SET status='sending', attempts=attempts+1, updated=? WHERE id IN (
      SELECT id FROM outbox WHERE status='queued' OR (status='failed' AND attempts < ?) OR (status='sending' AND updated < ? AND attempts < ?)
      ORDER BY created LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING id, message, attempts`)
    .bind(now, MAX_ATTEMPTS, now - STUCK, MAX_ATTEMPTS, room).all()).results;
  if (!rows.length) return report;
  // Each message is marked as soon as it's sent, so if the function is cut
  // off partway, the ones already delivered aren't sent again.
  const marked = new Set(), started = Date.now();
  const mark = async (i, result) => {
    const row = rows[i];
    if (!row || marked.has(i)) return;
    marked.add(i);
    if (result?.ok) {
      report.sent++;
      await db.prepare("UPDATE outbox SET status='sent', updated=?, error='' WHERE id=?").bind(Date.now(), row.id).run();
    } else if (result?.skipped) {
      await db.prepare("UPDATE outbox SET status='queued', attempts=attempts-1, updated=? WHERE id=?").bind(Date.now(), row.id).run();
    } else {
      report.failed++;
      const status = row.attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      await db.prepare('UPDATE outbox SET status=?, updated=?, error=? WHERE id=?')
        .bind(status, Date.now(), String(result?.error ?? 'unknown').slice(0, 200), row.id).run();
    }
  };
  // The uploaded logo, if it's switched on, goes in at sending time.
  const branding = await getBranding(db);
  const results = await mailer.sendEach(rows.map(r => { const m = JSON.parse(r.message); return {...m, html: swapLogo(m.html, branding)}; }),
    {onResult: mark, stop: () => Date.now() - started > budgetMs});
  for (const i of rows.keys()) await mark(i, results?.at(i));
  // Sent messages hold personal data and are not needed after a week.
  await db.prepare("DELETE FROM outbox WHERE status IN ('sent','dead') AND updated < ?").bind(now - 7 * DAY).run();
  return report;
}
