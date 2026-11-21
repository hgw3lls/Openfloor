// Weekly backup: every table that holds the group's own content, as gzipped
// JSON, emailed to the group inbox each Sunday. Sign-in data (sessions, codes,
// rate limits) and the outbox are left out: they're temporary and sensitive.
// Secret links (members' email-link tokens, old organizer links) are left
// out too; a restore makes new ones.
// To restore into an empty database: node scripts/restore.mjs backup.json.gz
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';

export const SECRET_COLUMNS = {members: ['token'], meetings: ['secret'], subscribers: ['token']};
const SKIP = new Set(['sessions', 'signin_codes', 'rate_events', 'rate_counts', 'outbox', 'replies_seen', 'reply_keys']);

// In the order the schema creates them, so a restore can insert in this order.
export function backupTables() {
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  return [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]).filter(t => !SKIP.has(t));
}

export async function backupData(db, now = Date.now()) {
  const tables = {};
  for (const t of backupTables()) {
    const rows = (await db.prepare(`SELECT * FROM ${t}`).bind().all()).results;
    const hide = SECRET_COLUMNS[t] ?? [];
    tables[t] = rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !hide.includes(k))));
  }
  return {app: 'openfloor', version: 1, created: new Date(now).toISOString(), tables};
}

export async function weeklyBackup(db, mailer, {now = Date.now(), env = process.env, force = false} = {}) {
  const to = env.BACKUP_TO?.trim() || env.SMTP_USER?.trim();
  if (!mailer || !to) return {skipped: 'no mailer'};
  if (!force && new Date(now).getUTCDay() !== 0) return {skipped: 'not Sunday'};
  const day = new Date(now).toISOString().slice(0, 10);
  // One a day at most, even if the job runs twice.
  const claimed = await db.prepare(`INSERT INTO settings (key,value) VALUES ('backup_sent',?)
    ON CONFLICT (key) DO UPDATE SET value=excluded.value WHERE settings.value<>excluded.value RETURNING value`).bind(day).first();
  if (!claimed) return {skipped: 'already sent'};
  const data = await backupData(db, now);
  const file = gzipSync(JSON.stringify(data));
  const counts = Object.entries(data.tables).map(([t, rows]) => `${t}: ${rows.length}`).join('\n');
  const [result] = await mailer.sendEach([{to, subject: `Tower Press backup ${day}`,
    text: `The weekly backup of the members app is attached (${Math.ceil(file.length / 1024)} KB).\n\nKeep a few of these. To restore into an empty database, see scripts/restore.mjs in the repository.\n\n${counts}\n`,
    html: `<p>The weekly backup of the members app is attached (${Math.ceil(file.length / 1024)} KB).</p><p>Keep a few of these. To restore into an empty database, see <code>scripts/restore.mjs</code> in the repository.</p><pre>${counts}</pre>`,
    attachments: [{filename: `tower-press-backup-${day}.json.gz`, content: file.toString('base64'), contentType: 'application/gzip'}]}]);
  if (!result?.ok) {
    await db.prepare("DELETE FROM settings WHERE key='backup_sent'").bind().run();
    return {failed: result?.error ?? 'unknown'};
  }
  return {sent: true, bytes: file.length};
}

// Puts a backup back. Rows that already exist are left alone. Secret links
// that weren't in the backup get new values, so old email links stop working
// and members sign in again by email.
export async function restoreData(db, data) {
  if (data?.app !== 'openfloor' || !data.tables) throw new Error('This isn’t a Tower Press backup.');
  const {randomBytes} = await import('node:crypto');
  const report = {};
  for (const t of backupTables()) {
    const rows = data.tables[t] ?? [];
    let added = 0;
    for (const row of rows) {
      const full = {...row};
      for (const c of SECRET_COLUMNS[t] ?? []) full[c] = randomBytes(32).toString('hex');
      const cols = Object.keys(full).filter(c => /^\w+$/.test(c));
      const r = await db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`)
        .bind(...cols.map(c => full[c] !== null && typeof full[c] === 'object' ? JSON.stringify(full[c]) : full[c])).run();
      added += r.meta.changes ?? 0;
    }
    report[t] = `${added} of ${rows.length}`;
  }
  return report;
}
