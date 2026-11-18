// Daily job: creates the next meeting of each repeating series, emails a
// digest of new topics and a reminder before each meeting, and sends
// anything still waiting in the outbox.
import {pruneAuth} from './auth.mjs';
import {threadOf} from './actions.mjs';
import {agendaEmail, digestEmail, meetingEmail} from './email.mjs';
import {prune} from './limits.mjs';
import {nextOccurrence} from './schedule.mjs';
import {markSent, notify, replyFor, withReplies} from './notify.mjs';
import {enqueue, flush} from './outbox.mjs';

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
      report.emails += await notify(db, mailer, created, async sub => meetingEmail({meeting: created, sub, base, kind: 'new', replyTo: await replyFor(db, sub, 'meeting', created.id)}));
      await markSent(db, created, {announced: true});
    }
  }
  if (!mailer || !base) return report;

  // Summaries: each member's daily or weekly email of new topics, posts and replies.
  // Members who chose "everything right away" already got posts and replies,
  // so their daily summary only lists new topics to vote on.
  const DAY = 86400000, monday = new Date(now).getUTCDay() === 1;
  const people = (await run(`SELECT id,email,name,token,'m:'||id AS voter,digest,digest_at FROM members WHERE status='active' AND emails='all'`).all()).results;
  for (const sub of people) {
    const last = Number(sub.digest_at);
    const due = sub.digest === 'weekly' ? monday && now - last > 6 * DAY : now - last > 20 * 3600000;
    if (!due) continue;
    const since = last || now - (sub.digest === 'weekly' ? 7 : 1) * DAY;
    const topics = (await run(`SELECT t.id,t.label,t.detail,t.kind,t.author,t.meeting FROM topics t JOIN meetings m ON m.id=t.meeting
      WHERE t.hidden=false AND m.phase<>'agenda' AND t.created > ? AND t.created <= ? AND t.author<>? ORDER BY m.starts_at NULLS LAST, t.created`, since, now, sub.voter).all()).results;
    const meetings = [];
    for (const t of topics) {
      let group = meetings.find(g => g.meeting.id === t.meeting);
      if (!group) meetings.push(group = {meeting: await run('SELECT * FROM meetings WHERE id=?', t.meeting).first(), topics: []});
      group.topics.push(t);
    }
    for (const g of meetings) g.topics = await withReplies(db, sub, g.topics);
    let posts = [], comments = [];
    if (sub.digest !== 'instant') {
      posts = (await run(`SELECT p.id,p.title,p.body,m.name,m.email FROM posts p JOIN members m ON m.id=p.author
        WHERE p.hidden=false AND p.created > ? AND p.created <= ? AND p.author<>? ORDER BY p.created`, since, now, sub.id).all()).results;
      for (const p of posts) { p.author = {name: p.name, email: p.email}; p.reply = await replyFor(db, sub, 'post', p.id); }
      const rows = (await run(`SELECT c.kind,c.target,c.body,m.name,m.email FROM comments c JOIN members m ON m.id=c.author
        WHERE c.hidden=false AND c.created > ? AND c.created <= ? AND c.author<>? ORDER BY c.created`, since, now, sub.id).all()).results;
      for (const c of rows) {
        const thread = await threadOf(db, c.kind, c.target);
        if (thread) comments.push({thread, body: c.body, author: {name: c.name, email: c.email}, reply: await replyFor(db, sub, c.kind, c.target)});
      }
    }
    if (meetings.length || posts.length || comments.length) {
      report.emails += await enqueue(db, '', [digestEmail({sub, base, period: sub.digest === 'weekly' ? 'weekly' : 'daily', meetings, posts, comments})], now);
      report.digests++;
    }
    await run('UPDATE members SET digest_at=? WHERE id=?', now, sub.id).run();
  }

  // Reminder: meetings starting in the next 36 hours (the job runs once a day).
  const soon = (await run(`SELECT * FROM meetings WHERE starts_at > ? AND starts_at <= ?`,
    new Date(now).toISOString(), new Date(now + 36 * 3600000).toISOString()).all()).results;
  for (const meeting of soon) {
    const start = new Date(meeting.starts_at).toISOString();
    if (JSON.parse(meeting.sent || '{}').reminder === start) continue;
    const sent = await notify(db, mailer, meeting, async sub => agendaEmail({meeting, sub, base, kind: 'reminder', replyTo: await replyFor(db, sub, 'meeting', meeting.id)}));
    await markSent(db, meeting, {reminder: start});
    if (sent) { report.reminders++; report.emails += sent; }
  }
  // Send everything queued, including retries of earlier failures.
  const sent = await flush(db, mailer, {limit: 1000, now});
  report.sent = sent.sent; report.failed = sent.failed;
  return report;
}
