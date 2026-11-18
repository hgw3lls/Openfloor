import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, link, visit, uuid, ORIGIN, KEY} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';
import {flush} from '../lib/outbox.mjs';
import {calendarFile, zonedToUtc} from '../lib/schedule.mjs';

const ALICE = uuid(1), BEN = uuid(2), CARA = uuid(3), ORG = uuid(4);

async function newMeeting(db, mailer) {
  const org = client(db, mailer, {cookie: ORG});
  const created = await org.call('', {organizerKey: KEY, title: 'Spring show'});
  assert.equal(created.status, 201);
  const M = {meeting: created.body.id}, A = {...M, secret: created.body.secret};
  return {org, M, A};
}

test('migration carries old votes over once and can run again', async () => {
  const {pg} = await setup({legacy: async pg => {
    await pg.query("INSERT INTO meetings (id,secret,title,schedule) VALUES ('m1','s','Old','')");
    await pg.query("INSERT INTO topics (id,meeting,label,detail,kind,created) VALUES ('t1','m1','Old topic','','Update',1)");
    await pg.query("INSERT INTO votes VALUES ('m1','v1','t1','')");
  }});
  assert.equal((await pg.query('SELECT count(*)::int n FROM ballots')).rows[0].n, 1);
});

test('voting: up/down, toggling, sorting, hidden counts, no voting on your own topic', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  const {M, A, org} = await newMeeting(db, mailer);
  const alice = client(db, mailer, {cookie: ALICE}), ben = client(db, mailer, {cookie: BEN});
  await alice.call('topic', {label: 'Budget', detail: 'Money', kind: 'Decision'}, M);
  await alice.call('topic', {label: 'Poster', kind: 'Discussion'}, M);
  let g = await ben.get(M);
  const [t1, t2] = g.body.topics;
  assert.equal(t1.up, null, 'counts hidden from participants');
  assert.equal(t1.own, false);
  assert.equal((await ben.call('vote', {topic: t2.id, value: 1}, M)).status, 200);
  await ben.call('vote', {topic: t1.id, value: -1}, M);
  g = await ben.get(M);
  assert.equal(g.body.topics[0].id, t2.id, 'up-voted topic sorts first');
  assert.equal(g.body.topics[0].mine, 1);
  await ben.call('vote', {topic: t2.id, value: 0}, M);
  assert.equal((await ben.get(M)).body.topics.find(t => t.id === t2.id).mine, 0, 'vote removed');
  await ben.call('vote', {topic: t2.id, value: 1}, M);

  // Alice suggested both topics: she can't vote on them.
  const mine = (await alice.get(M)).body.topics;
  assert.ok(mine.every(t => t.own), 'author sees own topics marked');
  const own = await alice.call('vote', {topic: t1.id, value: 1}, M);
  assert.equal(own.status, 403);
  assert.match(own.body.error, /your own topic/);

  g = await org.get(A);
  assert.equal(g.body.topics[0].up, 1, 'organizer sees counts');
});

test('moderation: organizers edit, hide and delete topics; participants cannot', async () => {
  const {db} = await setup();
  const {M, A, org} = await newMeeting(db, fakeMailer());
  const ben = client(db, null, {cookie: BEN});
  await ben.call('topic', {label: 'Spam spam'}, M);
  await ben.call('topic', {label: 'Real topic'}, M);
  const [spam, real] = (await org.get(A)).body.topics;
  const cara = client(db, null, {cookie: CARA});
  await cara.call('vote', {topic: spam.id, value: 1}, M);

  assert.equal((await ben.call('topic-hide', {topic: spam.id, hidden: true}, M)).status, 403, 'participants cannot moderate');
  assert.equal((await org.call('topic-hide', {topic: spam.id, hidden: true}, A)).status, 200);
  assert.deepEqual((await cara.get(M)).body.topics.map(t => t.label), ['Real topic'], 'hidden from participants');
  assert.equal((await org.get(A)).body.topics.find(t => t.id === spam.id).hidden, true, 'organizer still sees it');
  assert.equal((await cara.call('vote', {topic: spam.id, value: 1}, M)).status, 409, 'no votes on hidden topics');

  await org.call('topic-edit', {topic: real.id, label: 'Real topic, renamed', detail: 'More', kind: 'Update'}, A);
  const edited = (await cara.get(M)).body.topics.find(t => t.id === real.id);
  assert.deepEqual([edited.label, edited.detail, edited.kind], ['Real topic, renamed', 'More', 'Update']);
  assert.equal((await org.call('topic-edit', {topic: real.id, label: ' '}, A)).status, 400);

  assert.equal((await org.call('topic-delete', {topic: spam.id}, A)).status, 200);
  assert.equal((await org.get(A)).body.topics.length, 1, 'deleted, votes and all');
});

test('spam protection: honeypot, rate limits and the daily email budget', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  const {M} = await newMeeting(db, mailer);
  const bot = client(db, mailer, {cookie: BEN, ip: '198.51.100.7'});
  const trapped = await bot.call('subscribe', {email: 'victim@example.org', website: 'http://spam'}, M);
  assert.equal(trapped.status, 200, 'bots get a normal-looking answer');
  assert.equal(mailer.outbox.length, 0, 'but nothing is sent');

  for (let i = 0; i < 5; i++) assert.equal((await bot.call('subscribe', {email: `p${i}@example.org`}, M)).status, 200);
  assert.equal((await bot.call('subscribe', {email: 'p6@example.org'}, M)).status, 429, '6th sign-up in an hour is refused');
  const other = client(db, mailer, {cookie: CARA, ip: '198.51.100.8'});
  assert.equal((await other.call('subscribe', {email: 'p6@example.org'}, M)).status, 200, 'other visitors are unaffected');

  for (let i = 0; i < 20; i++) await other.call('topic', {label: 'T' + i}, M);
  assert.equal((await other.call('topic', {label: 'one too many'}, M)).status, 429);

  process.env.EMAIL_DAILY_LIMIT = '6';
  try {
    const third = client(db, mailer, {cookie: ALICE, ip: '198.51.100.9'});
    assert.equal((await third.call('subscribe', {email: 'last@example.org'}, M)).status, 429, 'daily budget reached');
  } finally { delete process.env.EMAIL_DAILY_LIMIT; }
});

test('outbox: failed sends are retried; over-budget mail waits instead of being dropped', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  const {M} = await newMeeting(db, mailer);
  mailer.failNext = 1;
  await client(db, mailer, {cookie: BEN}).call('subscribe', {email: 'ben@example.org'}, M);
  assert.equal(mailer.outbox.length, 0, 'first attempt failed');
  const retry = await flush(db, mailer);
  assert.deepEqual(retry, {sent: 1, failed: 0});
  assert.equal(mailer.outbox[0].to, 'ben@example.org');

  process.env.EMAIL_DAILY_LIMIT = '1';
  try {
    await db.prepare("INSERT INTO outbox (id,meeting,recipient,message,created,updated) VALUES ('x',?, 'z@example.org', ?, 1, 1)")
      .bind(M.meeting, JSON.stringify({to: 'z@example.org', subject: 's', html: '', text: ''})).run();
    assert.deepEqual(await flush(db, mailer), {sent: 0, failed: 0}, 'budget used up: waits');
    assert.equal((await db.prepare("SELECT status FROM outbox WHERE id='x'").bind().first()).status, 'queued');
  } finally { delete process.env.EMAIL_DAILY_LIMIT; }
});

test('email list end to end: confirm, digest, email votes, phases, schedule, agenda, reminder, outcomes, unsubscribe', async () => {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const {M, A, org} = await newMeeting(db, mailer);
  const alice = client(db, mailer, {cookie: ALICE}), ben = client(db, mailer, {cookie: BEN});

  // Alice signs up on the site; her browser links her email to her topics.
  let r = await alice.call('subscribe', {email: 'Alice@Example.org'}, M);
  assert.equal(r.body.notice, 'Check your inbox to confirm.');
  assert.equal(mailer.outbox.length, 1);
  assert.equal(mailer.outbox[0].to, 'alice@example.org');
  assert.ok(!mailer.outbox[0].headers, 'no unsubscribe header on the confirmation');
  await alice.call('subscribe', {email: 'alice@example.org'}, M);
  assert.equal(mailer.outbox.length, 1, 'no second confirmation within a day');
  const confirm = link('confirm', mailer.outbox[0].html);
  assert.match((await visit(db, confirm)).text, /Get email updates/);
  assert.equal((await pg.query('SELECT status FROM subscribers')).rows[0].status, 'pending', 'opening the link changes nothing');
  assert.match((await visit(db, confirm, 'POST', ALICE)).text, /on the list/);
  assert.equal((await alice.call('subscribe', {email: 'alice@example.org'}, M)).body.notice, 'You are already getting updates.');

  // Organizer invites Ben and Cara.
  mailer.outbox.length = 0;
  r = await org.call('invite', {emails: 'ben@example.org, bad, alice@example.org\ncara@example.org'}, A);
  assert.equal(r.body.notice, 'Sending 2 confirmation emails. Skipped 1 invalid address.');
  for (const m of mailer.outbox) await visit(db, link('confirm', m.html), 'POST');
  await org.call('remove', {email: 'cara@example.org'}, A);
  assert.deepEqual((await org.get(A)).body.subscribers.map(s => s.email + ':' + s.status), ['alice@example.org:active', 'ben@example.org:active']);

  // Daily digest: Alice's topic shows as hers in her email, with no vote buttons.
  await alice.call('topic', {label: 'Budget'}, M);
  await ben.call('topic', {label: 'Poster'}, M);
  mailer.outbox.length = 0;
  let rep = await daily(db, mailer, ORIGIN);
  assert.equal(rep.sent, 2);
  const aliceMail = mailer.outbox.find(m => m.to === 'alice@example.org'), benMail = mailer.outbox.find(m => m.to === 'ben@example.org');
  assert.match(aliceMail.subject, /2 new topics/);
  assert.equal((aliceMail.html.match(/a=vote/g) || []).length, 2, 'Alice: buttons only on Ben\'s topic');
  assert.match(aliceMail.html, /Your topic/);
  assert.equal((benMail.html.match(/a=vote/g) || []).length, 4, 'Ben was invited and never linked his browser, so the app cannot tell which topic is his');
  rep = await daily(db, mailer, ORIGIN);
  assert.equal(rep.emails, 0, 'topics announced once');

  // Alice votes from email; it counts as the same person as on the site.
  const voteUrl = link('vote', aliceMail.html);
  assert.match((await visit(db, voteUrl)).text, /Confirm your vote/);
  assert.match((await visit(db, voteUrl, 'POST')).text, /saved: 👍 up/);
  const poster = (await alice.get(M)).body.topics.find(t => t.label === 'Poster');
  assert.equal(poster.mine, 1, 'email vote shows as hers on the site');
  await visit(db, voteUrl.replace('v=1', 'v=-1'), 'POST');
  assert.equal((await pg.query('SELECT count(*)::int n FROM ballots')).rows[0].n, 1, 'changed, not duplicated');

  // Ben's own topic can't be voted on from a forged link either, once his email is linked to his browser.
  await pg.query("UPDATE subscribers SET voter=$1 WHERE email='ben@example.org'", ['c:' + BEN]);
  const ownLink = link('vote', aliceMail.html).replace(/topic=[^&]+/, 'topic=' + poster.id).replace(/t=[^&]+/, 't=' + (await pg.query("SELECT token FROM subscribers WHERE email='ben@example.org'")).rows[0].token);
  assert.equal((await visit(db, ownLink, 'POST')).status, 403);

  // Close submissions: one voting email, hidden topics left out.
  const budget = (await org.get(A)).body.topics.find(t => t.label === 'Budget');
  await org.call('topic-hide', {topic: budget.id, hidden: true}, A);
  mailer.outbox.length = 0;
  r = await org.call('phase', {phase: 'vote'}, A);
  assert.equal(r.body.notice, 'Sending to 2 people.');
  assert.match(mailer.outbox[0].subject, /^Vote on the topics/);
  assert.ok(!mailer.outbox.some(m => m.html.includes('Budget')), 'hidden topic not emailed');
  assert.equal((await alice.call('topic', {label: 'late'}, M)).status, 409, 'submissions closed');
  await org.call('phase', {phase: 'collect'}, A); mailer.outbox.length = 0;
  await org.call('phase', {phase: 'vote'}, A);
  assert.equal(mailer.outbox.length, 0, 'voting email only once');

  // Schedule and calendar.
  mailer.outbox.length = 0;
  r = await org.call('schedule', {local: '2026-12-03T19:00', timezone: 'America/New_York', duration: '90', location: 'Gallery', notify: true}, A);
  assert.equal(r.body.notice, 'Sending to 2 people.');
  assert.match(mailer.outbox[0].subject, /^Save the date/);
  const g = await alice.get(M);
  assert.equal(g.body.startsAt, '2026-12-04T00:00:00.000Z');
  assert.match(g.body.when, /Thursday, December 3, 2026.*7:00.PM EST/);
  assert.equal(zonedToUtc('2026-07-01T09:30', 'Europe/Berlin').toISOString(), '2026-07-01T07:30:00.000Z', 'daylight saving time');
  assert.equal((await org.call('schedule', {local: '2026-12-03T19:00', timezone: 'Mars/Base'}, A)).status, 400);

  // Agenda: emailed on first publish only; email voting closes.
  mailer.outbox.length = 0;
  r = await org.call('agenda', {agenda: [{label: 'Poster', minutes: 20, kind: 'Decision'}]}, A);
  assert.equal(r.body.notice, 'Sending to 2 people.');
  assert.match(mailer.outbox[0].html, /api\/calendar\?meeting=/);
  mailer.outbox.length = 0; await org.call('agenda', {agenda: [{label: 'Poster', minutes: 25}]}, A);
  assert.equal(mailer.outbox.length, 0);
  assert.equal((await visit(db, voteUrl, 'POST')).status, 409);

  // Reminder about a day before, once.
  const start = Date.parse('2026-12-04T00:00:00Z');
  mailer.outbox.length = 0;
  assert.equal((await daily(db, mailer, ORIGIN, start - 48 * 3600000)).reminders, 0);
  assert.equal((await daily(db, mailer, ORIGIN, start - 20 * 3600000)).reminders, 1);
  assert.match(mailer.outbox[0].subject, /^Reminder/);
  assert.equal((await daily(db, mailer, ORIGIN, start - 10 * 3600000)).reminders, 0);

  // Outcomes, then one-click unsubscribe.
  assert.equal((await org.call('email', {kind: 'outcomes'}, A)).status, 400);
  await org.call('notes', {notes: 'Alice books the room'}, A);
  mailer.outbox.length = 0;
  await org.call('email', {kind: 'outcomes'}, A);
  assert.equal(mailer.outbox.length, 2);
  const unsub = link('unsub', mailer.outbox[0].html);
  assert.match((await visit(db, unsub)).text, /Stop email updates/);
  assert.match((await visit(db, unsub, 'POST')).text, /unsubscribed/);
  mailer.outbox.length = 0;
  await org.call('email', {kind: 'outcomes'}, A);
  assert.equal(mailer.outbox.length, 1, 'unsubscribed person skipped');

  const row = (await pg.query('SELECT * FROM meetings WHERE id=$1', [M.meeting])).rows[0];
  const ics = calendarFile(row, ORIGIN + '/#' + row.id);
  assert.match(ics, /DTSTART:20261204T000000Z/);
  assert.match(ics, /DTEND:20261204T013000Z/);
  assert.ok(ics.split('\r\n').every(l => l.length <= 75));
});

test('organizer access needs the exact secret', async () => {
  const {db} = await setup();
  const {M, A} = await newMeeting(db, null);
  const someone = client(db, null, {cookie: BEN});
  assert.equal((await someone.call('notes', {notes: 'x'}, {...M, secret: A.secret.slice(0, -1) + '0'})).status, 403);
  assert.equal((await someone.call('notes', {notes: 'x'}, A)).status, 200);
});

test('without email settings the app still works and says so', async () => {
  const {db} = await setup();
  const {M} = await newMeeting(db, null);
  const r = await client(db, null, {cookie: BEN}).call('subscribe', {email: 'z@example.org'}, M);
  assert.equal(r.status, 409);
});
