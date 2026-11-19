import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member, link, visit, ORIGIN} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';
import {flush} from '../lib/outbox.mjs';
import {feed} from '../lib/feed.mjs';
import {emailActions} from '../lib/actions.mjs';
import {processMessage} from '../lib/replies.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';
const DAY = 86400000;
const PASS = 'mx.google.com; dkim=pass header.i=@example.org; dmarc=pass header.from=example.org';
let n = 0;
const raw = (from, to, body) => `From: ${from}\r\nTo: ${to}\r\nSubject: Re\r\nAuthentication-Results: ${PASS}\r\nMessage-ID: <f-${++n}@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const local = ms => new Date(ms).toISOString().slice(0, 16);
const day = offset => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  const w = {db, pg, mailer, o, a, b, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}), ben: client(db, mailer, {session: b.session})};
  w.set = async features => { const r = await w.org.group('features', features); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.features; };
  return w;
}

test('features: everything on by default; only organizers change them; bad values are ignored', async () => {
  const w = await world();
  const all = {topics: 'full', posts: 'full', comments: 'full', events: 'full', signups: 'full', calls: 'full'};
  assert.deepEqual((await w.ana.group()).body.features, all);
  assert.equal((await w.ana.group('features', {calls: 'off'})).status, 403);
  assert.deepEqual(await w.set({calls: 'off', posts: 'view', events: 'sideways', nonsense: 'off'}), {...all, calls: 'off', posts: 'view'});
  assert.deepEqual(await w.set({posts: 'full'}), {...all, calls: 'off'}, 'one change keeps the others');
  assert.ok((await w.org.group()).body.featureList.length === 6);
  assert.equal((await w.ana.group()).body.featureList, undefined);
});

test('off: hidden from members everywhere (site, dashboard, calendar, emails); organizers keep everything', async () => {
  const w = await world();
  await w.pg.query("UPDATE members SET digest='instant' WHERE email='ben@example.org'");
  const call = (await w.org.calls('create', {title: 'Print grant', deadline: day(5)})).body.id;
  await w.ana.calls('interest', {call, status: 'interested'});
  await w.ana.events('create', {title: 'Open studio', local: local(Date.now() + 5 * DAY), timezone: 'UTC'});
  const anaFeed = (await w.ana.group('feed', {})).body.feedUrl.split('feed=')[1];
  assert.match(await feed(w.db, anaFeed, ORIGIN), /Deadline: Print grant/);

  await w.set({calls: 'off', events: 'off'});
  assert.equal((await w.ana.calls()).status, 403);
  assert.match((await w.ana.calls()).body.error, /turned off/);
  assert.equal((await w.ana.calls('interest', {call, status: 'applying'})).status, 403);
  assert.equal((await w.ana.events()).status, 403);
  const dash = (await w.ana.group()).body;
  assert.deepEqual([dash.deadlines, dash.comingUp], [[], []]);
  const ics = await feed(w.db, anaFeed, ORIGIN);
  assert.ok(!ics.includes('Print grant') && !ics.includes('Open studio'));
  assert.equal((await w.org.calls()).body.open.length, 1, 'organizers still see calls');
  assert.equal((await w.org.group()).body.comingUp.length, 1);

  // Emails: new calls only reach organizers; summaries leave the sections out.
  const o2 = await member(w.db, 'org2@example.org', {role: 'organizer'});
  await w.pg.query("UPDATE members SET digest='instant' WHERE email='org2@example.org'");
  w.mailer.outbox.length = 0;
  await w.org.calls('create', {title: 'Second call', deadline: day(9)});
  assert.deepEqual(w.mailer.outbox.map(m => m.to), ['org2@example.org']);
  assert.ok(o2);
  w.mailer.outbox.length = 0;
  await w.pg.query("UPDATE members SET digest='daily', digest_at=$1", [Date.now() - DAY]);
  await daily(w.db, w.mailer, ORIGIN, Date.now() + 1000);
  assert.ok(!w.mailer.outbox.some(m => m.to === 'ben@example.org' && /Second call|Open studio/.test(m.html)), 'not in a member’s summary');
  assert.ok(w.mailer.outbox.some(m => m.to === 'org2@example.org' && /Second call/.test(m.html)), 'still in an organizer’s summary');

  // Back on: everything returns.
  await w.set({calls: 'full', events: 'full'});
  assert.equal((await w.ana.calls()).status, 200);
});

test('view only: members can read but not add, vote, sign up or reply, on the site or by email', async () => {
  const w = await world();
  const M = (await w.org.call('', {title: 'March meeting', local: local(Date.now() + 5 * DAY), timezone: 'UTC'})).body.id;
  await w.org.call('topic', {label: 'Budget'}, {meeting: M});
  const T = (await w.org.get({meeting: M})).body.topics[0].id;
  const P = (await w.org.posts('create', {title: 'Hello', body: 'Welcome'})).body.id;
  const E = (await w.org.events('create', {title: 'Install', local: local(Date.now() + 5 * DAY), timezone: 'UTC'})).body.id;
  await w.org.events('slot-add', {event: E, label: 'Crew', capacity: 3});
  const C = (await w.org.calls('create', {title: 'Grant', deadline: day(5)})).body.id;
  await w.set({topics: 'view', posts: 'view', comments: 'view', events: 'view', signups: 'view', calls: 'view'});

  const meeting = (await w.ana.get({meeting: M})).body;
  assert.deepEqual(meeting.topics.map(t => t.label), ['Budget'], 'topics still visible');
  assert.equal((await w.ana.call('vote', {topic: T, value: 1}, {meeting: M})).status, 403);
  assert.equal((await w.ana.call('topic', {label: 'Mine'}, {meeting: M})).status, 403);
  assert.equal((await w.ana.posts()).body.posts.length, 1);
  assert.equal((await w.ana.posts('', undefined, {post: P})).status, 200);
  assert.equal((await w.ana.posts('create', {title: 'x'})).status, 403);
  assert.equal((await w.ana.posts('comment', {kind: 'post', target: P, body: 'hi'})).status, 403);
  assert.equal((await w.ana.posts('comment', {kind: 'meeting', target: M, body: 'hi'})).status, 403);
  const ev = (await w.ana.events('', undefined, {event: E})).body.event;
  assert.equal(ev.slots.length, 1, 'slots still visible');
  assert.equal((await w.ana.events('claim', {slot: ev.slots[0].id})).status, 403);
  assert.equal((await w.ana.events('create', {title: 'x', local: local(Date.now() + DAY), timezone: 'UTC'})).status, 403);
  assert.equal((await w.ana.calls('', undefined, {call: C})).status, 200);
  assert.equal((await w.ana.calls('interest', {call: C, status: 'applying'})).status, 403);
  assert.equal((await w.ana.calls('create', {title: 'x', deadline: day(3)})).status, 403);

  // Organizers still can.
  assert.equal((await w.org.posts('comment', {kind: 'post', target: P, body: 'Organizer note'})).status, 201);
  assert.equal((await w.org.events('claim', {slot: ev.slots[0].id})).status, 200);

  // Email: reply-by-email and one-tap links follow the same rules.
  await w.org.events('announce', {event: E});
  const mail = w.mailer.outbox.find(m => m.to === 'ana@example.org' && m.subject === 'Install');
  assert.ok(!/a=claim/.test(mail.html), 'no sign-up buttons when members can’t sign up');
  const act = emailActions(w.db, {mailer: w.mailer, base: ORIGIN});
  assert.match(await processMessage(w.db, raw('ana@example.org', mail.replyTo, 'Can I help?'), act), /comment: Discussions and replies are view-only/);
  await w.set({calls: 'full'});
  await w.pg.query("UPDATE members SET digest='instant' WHERE email='ana@example.org'");
  await w.org.calls('create', {title: 'Residency', deadline: day(8)});
  const callMail = w.mailer.outbox.find(m => m.to === 'ana@example.org' && /Residency/.test(m.subject));
  await w.set({calls: 'view'});
  assert.match((await visit(w.db, link('call', callMail.html), 'POST')).text, /view-only/);

  // The voting email only goes to people who can vote.
  w.mailer.outbox.length = 0;
  await w.org.call('phase', {phase: 'vote'}, {meeting: M});
  await flush(w.db, w.mailer);
  assert.deepEqual(w.mailer.outbox.filter(m => /^Vote on the topics/.test(m.subject)).map(m => m.to), ['org@example.org']);
});

test('off: topics, sign-ups and discussions disappear from pages members can still open', async () => {
  const w = await world();
  const M = (await w.org.call('', {title: 'March meeting', local: local(Date.now() + 5 * DAY), timezone: 'UTC'})).body.id;
  await w.org.call('topic', {label: 'Budget'}, {meeting: M});
  await w.ana.posts('comment', {kind: 'meeting', target: M, body: 'See you there'});
  const E = (await w.org.events('create', {title: 'Install', local: local(Date.now() + 5 * DAY), timezone: 'UTC'})).body.id;
  await w.org.events('slot-add', {event: E, label: 'Crew', capacity: 3});
  await w.set({topics: 'off', signups: 'off', comments: 'off', posts: 'off'});
  const meeting = (await w.ben.get({meeting: M})).body;
  assert.deepEqual([meeting.topics, meeting.discussion], [[], undefined]);
  assert.equal((await w.org.get({meeting: M})).body.topics.length, 1, 'organizers still see topics');
  assert.equal((await w.ben.events('', undefined, {event: E})).body.event.slots.length, 0);
  assert.equal((await w.ben.posts()).status, 403);
  assert.equal((await w.ben.call('rsvp', {status: 'yes'}, {meeting: M})).status, 200, 'RSVPs always work');
});
