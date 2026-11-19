import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member, link, visit, ORIGIN} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';
import {emailActions} from '../lib/actions.mjs';
import {processMessage} from '../lib/replies.mjs';
import {feed} from '../lib/feed.mjs';
import {remindActions} from '../lib/follow.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';
const PASS = 'mx.google.com; dkim=pass header.i=@example.org; dmarc=pass header.from=example.org';
let n = 0;
const raw = (from, to, body) => `From: ${from}\r\nTo: ${to}\r\nSubject: Re\r\nAuthentication-Results: ${PASS}\r\nMessage-ID: <p3-${++n}@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const day = (offset, base = Date.now()) => new Date(base + offset * 86400000).toISOString().slice(0, 10);
const local = d => d.toISOString().slice(0, 16);

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  const w = {db, pg, mailer, o, a, b, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}), ben: client(db, mailer, {session: b.session})};
  const created = await w.org.call('', {title: 'March meeting', local: local(new Date(Date.now() + 5 * 86400000)), timezone: 'UTC'});
  w.M = {meeting: created.body.id};
  w.mailer.outbox.length = 0;
  return w;
}

test('action items: organizers assign them, the owner is emailed, and owners or organizers mark them done', async () => {
  const w = await world();
  assert.equal((await w.ana.call('action-add', {title: 'x'}, w.M)).status, 403, 'members cannot add');
  assert.equal((await w.org.call('action-add', {title: 'Book the gallery', owner: w.a.id, due: 'next week'}, w.M)).status, 400);
  const r = await w.org.call('action-add', {title: 'Book the gallery', owner: w.a.id, due: day(10)}, w.M);
  assert.equal(r.body.notice, 'Emailed the owner.');
  const mail = w.mailer.outbox[0];
  assert.equal(mail.to, 'ana@example.org');
  assert.equal(mail.subject, 'Action item: Book the gallery');
  assert.ok(mail.replyTo);
  const [item] = (await w.ben.get(w.M)).body.actions;
  assert.deepEqual([item.title, item.ownerName, item.status, item.mine], ['Book the gallery', 'Ana', 'open', false]);
  assert.equal((await w.ben.call('action-done', {action: item.id, done: true}, w.M)).status, 403, 'not Ben’s');
  assert.equal((await w.ana.call('action-done', {action: item.id, done: true}, w.M)).status, 200);
  assert.equal((await w.ana.group()).body.myActions.length, 0, 'done items leave the dashboard');
  await w.org.call('action-done', {action: item.id, done: false}, w.M);
  assert.equal((await w.ana.group()).body.myActions[0].title, 'Book the gallery', 'organizers can reopen');

  // The email link: opening it changes nothing; the button marks it done; undo works.
  const done = link('done', mail.html);
  assert.match((await visit(w.db, done)).text, /Mark done/);
  assert.equal((await w.ana.get(w.M)).body.actions[0].status, 'open');
  assert.match((await visit(w.db, done, 'POST')).text, /Marked done/);
  assert.equal((await w.ana.get(w.M)).body.actions[0].status, 'done');
  await visit(w.db, done, 'POST', {undo: '1'});
  assert.equal((await w.ana.get(w.M)).body.actions[0].status, 'open');
  const benToken = (await w.pg.query("SELECT token FROM members WHERE email='ben@example.org'")).rows[0].token;
  assert.equal((await visit(w.db, done.replace(/t=[^&]+/, 't=' + benToken), 'POST')).status, 403);

  // Replying "done" by email; anything else goes to the meeting's discussion.
  const act = emailActions(w.db, {mailer: w.mailer, base: ORIGIN});
  assert.equal(await processMessage(w.db, raw('ana@example.org', mail.replyTo, 'Can we use the back room instead?'), act), 'comment: ok');
  assert.equal((await w.ana.get(w.M)).body.actions[0].status, 'open');
  assert.equal(await processMessage(w.db, raw('ana@example.org', mail.replyTo, 'Done!\nBooked for the 14th.'), act), 'done: ok, comment: ok');
  const view = (await w.org.get(w.M)).body;
  assert.equal(view.actions[0].status, 'done');
  assert.deepEqual(view.discussion.map(c => c.body), ['Can we use the back room instead?', 'Booked for the 14th.']);
});

test('reminders: two days before, on the day, and once when overdue', async () => {
  const w = await world();
  const now = Date.parse('2030-03-10T16:00:00Z');
  await w.org.call('action-add', {title: 'Print flyers', owner: w.b.id, due: '2030-03-12'}, w.M);
  await w.org.call('action-add', {title: 'Already done', owner: w.b.id, due: '2030-03-12'}, w.M);
  const done = (await w.org.get(w.M)).body.actions.find(a => a.title === 'Already done');
  await w.org.call('action-done', {action: done.id, done: true}, w.M);
  w.mailer.outbox.length = 0;
  const subjects = async at => { w.mailer.outbox.length = 0; await remindActions(w.db, w.mailer, ORIGIN, at); const {flush} = await import('../lib/outbox.mjs'); await flush(w.db, w.mailer, {now: at}); return w.mailer.outbox.map(m => m.subject); };
  assert.deepEqual(await subjects(now - 86400000), [], 'three days out: nothing');
  assert.deepEqual(await subjects(now), ['Due soon: Print flyers']);
  assert.deepEqual(await subjects(now + 3600000), [], 'once');
  assert.deepEqual(await subjects(now + 2 * 86400000), ['Due today: Print flyers']);
  assert.deepEqual(await subjects(now + 3 * 86400000), ['Overdue: Print flyers']);
  assert.deepEqual(await subjects(now + 4 * 86400000), [], 'overdue reminder only once');
});

test('carry-over: topics that didn’t make the agenda move to the next meeting, once; repeating meetings do it themselves', async () => {
  const w = await world();
  await w.ana.call('topic', {label: 'Budget'}, w.M);
  await w.ben.call('topic', {label: 'Poster design'}, w.M);
  await w.ben.call('topic', {label: 'Spam'}, w.M);
  const spam = (await w.org.get(w.M)).body.topics.find(t => t.label === 'Spam');
  await w.org.call('topic-hide', {topic: spam.id, hidden: true}, w.M);
  await w.org.call('agenda', {agenda: [{label: 'Budget', minutes: 20}]}, w.M);
  const next = await w.org.call('', {title: 'April meeting', local: local(new Date(Date.now() + 35 * 86400000)), timezone: 'UTC'});
  const N = {meeting: next.body.id};
  assert.ok((await w.org.get(w.M)).body.otherMeetings.some(m => m.id === N.meeting));
  assert.equal((await w.ana.call('carry', {to: N.meeting}, w.M)).status, 403);
  assert.equal((await w.org.call('carry', {to: N.meeting}, w.M)).body.notice, 'Moved 1 topic.');
  const moved = (await w.ben.get(N)).body.topics;
  assert.deepEqual(moved.map(t => [t.label, t.carried, t.own]), [['Poster design', true, true]], 'keeps its author');
  assert.equal((await w.org.call('carry', {to: N.meeting}, w.M)).body.notice, 'No topics left to move.');

  // Repeating series.
  const r = await w.org.call('', {title: 'Weekly crit', local: local(new Date(Date.now() + 86400000)), timezone: 'UTC', repeat: 'weekly'});
  const R = {meeting: r.body.id};
  await w.ana.call('topic', {label: 'Show new prints'}, R);
  const start = Date.parse((await w.org.get(R)).body.startsAt);
  const rep = await daily(w.db, w.mailer, ORIGIN, start + 3 * 3600000);
  assert.equal(rep.carried, 1);
  const nextId = (await w.pg.query('SELECT next_meeting FROM meetings WHERE id=$1', [R.meeting])).rows[0].next_meeting;
  assert.deepEqual((await w.ana.get({meeting: nextId})).body.topics.map(t => t.label), ['Show new prints']);
});

test('calendar feed: a private link per member with every meeting and their own due dates', async () => {
  const w = await world();
  await w.org.call('action-add', {title: 'Bring the projector', owner: w.a.id, due: day(3)}, w.M);
  await w.org.call('action-add', {title: 'Not Ana’s', owner: w.b.id, due: day(3)}, w.M);
  await w.ana.call('rsvp', {status: 'yes'}, w.M);
  assert.equal((await w.ana.group()).body.feedUrl, '');
  const first = (await w.ana.group('feed', {})).body.feedUrl;
  const key = first.split('feed=')[1];
  const ics = await feed(w.db, key, ORIGIN);
  assert.match(ics, /SUMMARY:March meeting/);
  assert.match(ics, /Your RSVP: Going/);
  assert.match(ics, /SUMMARY:Due: Bring the projector/);
  assert.match(ics, /DTSTART;VALUE=DATE:/);
  assert.ok(!ics.includes('Not Ana'), 'only your own action items');
  const second = (await w.ana.group('feed', {})).body.feedUrl;
  assert.notEqual(second, first);
  assert.equal(await feed(w.db, key, ORIGIN), null, 'a new link replaces the old one');
  assert.equal(await feed(w.db, 'nope', ORIGIN), null);
});

test('decisions record and outcomes email include action items', async () => {
  const w = await world();
  await w.org.call('action-add', {title: 'Send the grant report', owner: w.o.id, due: day(7)}, w.M);
  await w.org.call('notes', {notes: 'We will apply for the city grant.'}, w.M);
  w.mailer.outbox.length = 0;
  await w.org.call('email', {kind: 'outcomes'}, w.M);
  const mail = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  assert.match(mail.html, /Action items/);
  assert.match(mail.html, /Send the grant report/);
  await w.pg.query("UPDATE meetings SET starts_at=now() - interval '2 days'");
  const {group} = await import('../lib/group.mjs');
  const res = await group(new Request(ORIGIN + '/api/group?view=decisions', {headers: {Cookie: 'session=' + w.b.session}}), w.db, 'k', null);
  const record = (await res.json()).decisions;
  assert.equal(record[0].title, 'March meeting');
  assert.equal(record[0].notes, 'We will apply for the city grant.');
  assert.equal(record[0].actions[0].title, 'Send the grant report');
});

test('deleting a meeting: organizers only, removes everything it owns, optional cancellation email, series not recreated', async () => {
  const w = await world();
  await w.ana.call('topic', {label: 'Budget'}, w.M);
  const topic = (await w.org.get(w.M)).body.topics[0];
  await w.ben.call('vote', {topic: topic.id, value: 1}, w.M);
  await w.ben.call('rsvp', {status: 'yes'}, w.M);
  await w.ben.posts('comment', {kind: 'meeting', target: w.M.meeting, body: 'See you there'});
  await w.ben.posts('comment', {kind: 'topic', target: topic.id, body: 'Yes please'});
  await w.org.call('action-add', {title: 'Book room', owner: w.a.id, due: day(5)}, w.M);
  // An email for this meeting that hasn't gone out yet.
  await w.pg.query("INSERT INTO outbox (id,meeting,recipient,message,created,updated) VALUES ('pending1',$1,'x@example.org','{}',1,1)", [w.M.meeting]);

  assert.equal((await w.ana.call('delete', {}, w.M)).status, 403, 'members cannot delete');
  const {secret} = (await w.pg.query('SELECT secret FROM meetings WHERE id=$1', [w.M.meeting])).rows[0];
  assert.equal((await client(w.db, null).call('delete', {}, {...w.M, secret})).status, 403, 'old organizer links cannot delete');

  w.mailer.outbox.length = 0;
  const r = await w.org.call('delete', {notify: true}, w.M);
  assert.equal(r.body.notice, 'Meeting deleted. Sending to 3 people.');
  assert.ok(w.mailer.outbox.every(m => m.subject === 'Cancelled: March meeting'));
  assert.equal(w.mailer.outbox.length, 3);
  assert.equal((await w.org.get(w.M)).status, 404);
  for (const [table, where] of [['topics', 'meeting'], ['ballots', 'meeting'], ['rsvps', 'meeting'], ['actions', 'meeting']]) {
    assert.equal((await w.pg.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}=$1`, [w.M.meeting])).rows[0].n, 0, table);
  }
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM comments")).rows[0].n, 0);
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM reply_keys WHERE kind IN ('meeting','topic','action')")).rows[0].n, 0);
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM outbox WHERE id='pending1'")).rows[0].n, 0, 'its unsent emails are dropped');

  // Without notify: no email. Deleting the next meeting of a series doesn't make the daily job recreate it.
  const s = await w.org.call('', {title: 'Weekly crit', local: local(new Date(Date.now() + 86400000)), timezone: 'UTC', repeat: 'weekly'});
  const start = Date.parse((await w.org.get({meeting: s.body.id})).body.startsAt);
  await daily(w.db, w.mailer, ORIGIN, start + 3 * 3600000);
  const next = (await w.pg.query('SELECT next_meeting FROM meetings WHERE id=$1', [s.body.id])).rows[0].next_meeting;
  w.mailer.outbox.length = 0;
  assert.equal((await w.org.call('delete', {}, {meeting: next})).body.notice, 'Meeting deleted.');
  assert.equal(w.mailer.outbox.length, 0);
  assert.equal((await daily(w.db, w.mailer, ORIGIN, start + 4 * 3600000)).created, 0, 'not recreated');
});

test('vote results in the minutes: organizers record each agenda item’s outcome', async () => {
  const w = await world();
  await w.org.call('agenda', {agenda: [{label: 'Press hire day rate goes up to £25', kind: 'Decision', minutes: 15}, {label: 'Winter show opens in Gallery 2', kind: 'Update', minutes: 10}]}, w.M);
  assert.equal((await w.ana.call('outcome', {index: 0, result: 'carried', for: 9, against: 2}, w.M)).status, 403, 'organizers only');
  assert.equal((await w.org.call('outcome', {index: 0, result: 'carried', for: '9', against: '2'}, w.M)).status, 200);
  assert.equal((await w.org.call('outcome', {index: 1, result: 'agreed', for: 5}, w.M)).status, 200);
  assert.equal((await w.org.call('outcome', {index: 7, result: 'noted'}, w.M)).status, 404);
  let agenda = (await w.ana.get(w.M)).body.agenda;
  assert.deepEqual(agenda.map(a => a.outcome), [{result: 'carried', for: 9, against: 2}, {result: 'agreed'}]);
  // Re-saving the agenda keeps results; an unknown result clears one.
  await w.org.call('agenda', {agenda: agenda}, w.M);
  await w.org.call('outcome', {index: 1, result: 'maybe'}, w.M);
  agenda = (await w.ana.get(w.M)).body.agenda;
  assert.deepEqual(agenda.map(a => a.outcome), [{result: 'carried', for: 9, against: 2}, undefined]);
  const {decisions} = await import('../lib/follow.mjs');
  await w.pg.query('UPDATE meetings SET starts_at=$1', [new Date(Date.now() - 86400000).toISOString()]);
  assert.deepEqual((await decisions(w.db)).find(m => m.id === w.M.meeting).agenda[0].outcome, {result: 'carried', for: 9, against: 2});
});
