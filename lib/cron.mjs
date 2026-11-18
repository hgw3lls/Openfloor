// Daily job: creates the next meeting of each repeating series, emails a
// digest of new topics and a reminder before each meeting, and sends
// anything still waiting in the outbox.
import {pruneAuth} from './auth.mjs';
import {agendaEmail, meetingEmail, topicsEmail} from './email.mjs';
import {prune} from './limits.mjs';
import {nextOccurrence} from './schedule.mjs';
import {markSent, notify} from './notify.mjs';
import {flush} from './outbox.mjs';

export async function daily(db, mailer, base, now = Date.now()) {
  const run = (sql, ...args) => db.prepare(sql).bind(...args);
  const report = {created: 0, digests: 0, reminders: 0, emails: 0, sent: 0, failed: 0};
  await prune(db, now);
  await pruneAuth(db, now);

  // Repeating meetings: once a meeting is over, create the next one.
  const finished = (await run(`SELECT * FROM meetings WHERE repeat<>'' AND next_meeting='' AND starts_at IS NOT NULL
    AND starts_at + make_interval(mins => duration) < ?`, new Date(now).toISOString()).all()).results;
  for (const meeting of finished) {
    let start = new Date(meeting.starts_at);
    do start = nextOccurrence(start, meeting.timezone, meeting.repeat); while (start && start.getTime() < now);
    if (!start) continue;
    const id = crypto.randomUUID();
    await run(`INSERT INTO meetings (id,secret,title,schedule,starts_at,timezone,duration,location,repeat,created) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, crypto.randomUUID(), meeting.title, meeting.schedule, start.toISOString(), meeting.timezone, meeting.duration, meeting.location, meeting.repeat, now).run();
    await run('UPDATE meetings SET next_meeting=? WHERE id=?', id, meeting.id).run();
    report.created++;
    if (mailer && base) {
      const created = await run('SELECT * FROM meetings WHERE id=?', id).first();
      report.emails += await notify(db, mailer, created, sub => meetingEmail({meeting: created, sub, base, kind: 'new'}));
      await markSent(db, created, {announced: true});
    }
  }
  if (!mailer || !base) return report;

  // Digest: topics nobody has been told about yet, while voting is still open.
  const pending = (await run(`SELECT DISTINCT m.* FROM meetings m JOIN topics t ON t.meeting=m.id
    WHERE t.announced=false AND t.hidden=false AND m.phase<>'agenda'`).all()).results;
  for (const meeting of pending) {
    const topics = (await run('SELECT id,label,detail,kind,author FROM topics WHERE meeting=? AND announced=false AND hidden=false ORDER BY created', meeting.id).all()).results;
    const count = topics.length;
    const sent = await notify(db, mailer, meeting, sub => topicsEmail({meeting, sub, base, topics,
      subject: `${count} new ${count === 1 ? 'topic' : 'topics'}: ${meeting.title}`,
      intro: `${count === 1 ? 'A new topic was' : count + ' new topics were'} suggested. Vote with one tap:`}));
    await run('UPDATE topics SET announced=true WHERE meeting=? AND id = ANY(?::text[])', meeting.id, topics.map(t => t.id)).run();
    if (sent) { report.digests++; report.emails += sent; }
  }

  // Reminder: meetings starting in the next 36 hours (the job runs once a day).
  const soon = (await run(`SELECT * FROM meetings WHERE starts_at > ? AND starts_at <= ?`,
    new Date(now).toISOString(), new Date(now + 36 * 3600000).toISOString()).all()).results;
  for (const meeting of soon) {
    const start = new Date(meeting.starts_at).toISOString();
    if (JSON.parse(meeting.sent || '{}').reminder === start) continue;
    const sent = await notify(db, mailer, meeting, sub => agendaEmail({meeting, sub, base, kind: 'reminder'}));
    await markSent(db, meeting, {reminder: start});
    if (sent) { report.reminders++; report.emails += sent; }
  }
  // Send everything queued, including retries of earlier failures.
  const sent = await flush(db, mailer, {limit: 1000, now});
  report.sent = sent.sent; report.failed = sent.failed;
  return report;
}
