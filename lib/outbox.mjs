// Email outbox. Messages are queued in the database, then sent in the
// background (after the response, and by the daily job). Failed sends are
// retried up to 5 times. A daily budget keeps Gmail under its sending limit:
// anything over the budget waits for the next run instead of being dropped.

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

export async function flush(db, mailer, {limit = 100, now = Date.now(), env = process.env} = {}) {
  const report = {sent: 0, failed: 0};
  if (!mailer) return report;
  const room = Math.min(limit, dailyLimit(env) - await sentLastDay(db, now));
  if (room <= 0) return report;
  const rows = (await db.prepare(`UPDATE outbox SET status='sending', attempts=attempts+1, updated=? WHERE id IN (
      SELECT id FROM outbox WHERE status='queued' OR (status='failed' AND attempts < ?) OR (status='sending' AND updated < ?)
      ORDER BY created LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING id, message, attempts`)
    .bind(now, MAX_ATTEMPTS, now - STUCK, room).all()).results;
  if (!rows.length) return report;
  const results = await mailer.sendEach(rows.map(r => JSON.parse(r.message)));
  for (const [i, row] of rows.entries()) {
    const result = results.at(i);
    if (result?.ok) {
      report.sent++;
      await db.prepare("UPDATE outbox SET status='sent', updated=?, error='' WHERE id=?").bind(Date.now(), row.id).run();
    } else {
      report.failed++;
      const status = row.attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      await db.prepare('UPDATE outbox SET status=?, updated=?, error=? WHERE id=?')
        .bind(status, Date.now(), String(result?.error ?? 'unknown').slice(0, 200), row.id).run();
    }
  }
  // Sent messages hold personal data and are not needed after a week.
  await db.prepare("DELETE FROM outbox WHERE status IN ('sent','dead') AND updated < ?").bind(now - 7 * DAY).run();
  return report;
}
