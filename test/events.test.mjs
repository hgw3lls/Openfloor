import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member, link, visit, ORIGIN} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';
import {flush} from '../lib/outbox.mjs';
import {feed} from '../lib/feed.mjs';
import {remindSlots} from '../lib/events.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';
const local = ms => new Date(ms).toISOString().slice(0, 16);
const DAY = 86400000;

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  return {db, pg, mailer, o, a, b, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}), ben: client(db, mailer, {session: b.session}), guest: client(db, mailer)};
}
async function showWithSlots(w, start = Date.now() + 10 * DAY) {
  const created = await w.ana.events('create', {title: 'Winter group show', kind: 'Show', local: local(start), timezone: 'UTC', duration: 3 * 24 * 60, location: 'Tower Press gallery'});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const E = created.body.id;
  await w.ana.events('slot-add', {event: E, label: 'Gallery sitting Sat 12–3', local: local(start + DAY), duration: 180, capacity: 2});
  await w.ana.events('slot-add', {event: E, label: 'Install crew', capacity: 1});
  return E;
}

test('events: any member adds one; only the author or an organizer can change it; members only', async () => {
  const w = await world();
  assert.equal((await w.guest.events()).status, 401);
  assert.equal((await w.ana.events('create', {title: 'x', local: 'soon', timezone: 'UTC'})).status, 400);
  assert.equal((await w.ana.events('create', {title: 'x', local: local(Date.now() + DAY), timezone: 'UTC', link: 'javascript:alert(1)'})).status, 400, 'only web links');
  const E = await showWithSlots(w);
  assert.equal((await w.ben.events('update', {event: E, title: 'Mine now'})).status, 403);
  assert.equal((await w.ben.events('slot-add', {event: E, label: 'x'})).status, 403);
  assert.equal((await w.org.events('update', {event: E, title: 'Winter group show 2026'})).status, 200, 'organizers can edit');
  const list = (await w.ben.events()).body;
  assert.equal(list.upcoming[0].title, 'Winter group show 2026');
  assert.deepEqual([list.upcoming[0].spots, list.upcoming[0].taken], [3, 0]);
  const view = (await w.ben.events('', undefined, {event: E})).body.event;
  assert.deepEqual(view.slots.map(s => [s.label, s.capacity, s.taken]), [['Gallery sitting Sat 12–3', 2, 0], ['Install crew', 1, 0]]);
  assert.equal(view.canEdit, false);
  assert.equal((await w.ana.events('', undefined, {event: E})).body.event.canEdit, true);
  await w.org.events('hide', {event: E, hidden: true});
  assert.equal((await w.ben.events()).body.upcoming.length, 0, 'hidden from members');
  assert.equal((await w.ana.events('hide', {event: E, hidden: false})).status, 403, 'only organizers hide');
});

test('sign-ups: claim, drop out, no overfilling; email sign-up links are scanner-safe', async () => {
  const w = await world();
  const E = await showWithSlots(w);
  const [sitting, crew] = (await w.org.events('', undefined, {event: E})).body.event.slots;
  assert.equal((await w.ben.events('claim', {slot: crew.id})).status, 200);
  assert.equal((await w.ana.events('claim', {slot: crew.id})).status, 409, 'full');
  assert.equal((await w.ben.events('claim', {slot: crew.id})).status, 200, 'claiming twice is fine');
  await w.ben.events('unclaim', {slot: crew.id});
  assert.equal((await w.ana.events('claim', {slot: crew.id})).status, 200, 'free again');

  // Organizer emails everyone; Ben signs up from his inbox.
  assert.equal((await w.ana.events('announce', {event: E})).status, 403, 'only organizers email everyone');
  w.mailer.outbox.length = 0;
  assert.equal((await w.org.events('announce', {event: E})).body.notice, 'Sending to 3 people.');
  const benMail = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  assert.equal(benMail.subject, 'Winter group show');
  assert.ok(!benMail.html.includes('Install crew'), 'full slots are left out');
  const claimUrl = link('claim', benMail.html);
  assert.match((await visit(w.db, claimUrl)).text, /Sign me up/);
  assert.equal((await w.org.events('', undefined, {event: E})).body.event.slots[0].taken, 0, 'opening the link signs nobody up');
  assert.match((await visit(w.db, claimUrl, 'POST')).text, /You’re signed up/);
  assert.deepEqual((await w.org.events('', undefined, {event: E})).body.event.slots[0].people.map(p => p.name), ['Ben']);

  // Ask for help: only people not signed up yet, only while slots are open.
  w.mailer.outbox.length = 0;
  assert.equal((await w.org.events('help', {event: E})).body.notice, 'Sending to 1 person.');
  assert.deepEqual(w.mailer.outbox.map(m => m.to), ['org@example.org']);
  assert.match(w.mailer.outbox[0].subject, /^Help needed/);
  await w.org.events('claim', {slot: sitting.id});
  assert.equal((await w.org.events('help', {event: E})).body.notice, 'Every slot is filled.');

  // Dashboard and organizer removal.
  const dash = (await w.ben.group()).body;
  assert.deepEqual(dash.mySlots.map(s => s.label), ['Gallery sitting Sat 12–3']);
  assert.equal((await w.ana.events('remove-claim', {event: E, slot: sitting.id, member: w.b.id})).status, 200, 'the author can manage sign-ups');
  assert.equal((await w.ben.group()).body.mySlots.length, 0);
});

test('reminders the day before each sign-up, once; events in summaries and calendars; replies go to the discussion', async () => {
  const w = await world();
  const start = Date.parse('2030-05-10T18:00:00Z');
  const E = await showWithSlots(w, start);
  const [sitting, crew] = (await w.org.events('', undefined, {event: E})).body.event.slots;
  await w.ben.events('claim', {slot: sitting.id});
  await w.ben.events('claim', {slot: crew.id});
  w.mailer.outbox.length = 0;
  const run = async at => { w.mailer.outbox.length = 0; await remindSlots(w.db, w.mailer, ORIGIN, at); await flush(w.db, w.mailer, {now: at}); return w.mailer.outbox.map(m => m.subject); };
  assert.deepEqual(await run(start - 3 * DAY), []);
  assert.deepEqual(await run(start - 20 * 3600000), ['Tomorrow: Install crew'], 'a slot without a time uses the event start');
  assert.deepEqual(await run(start + 4 * 3600000), ['Tomorrow: Gallery sitting Sat 12–3']);
  assert.deepEqual(await run(start + 5 * 3600000), [], 'once');

  // Summaries include events members added (not announced), but not to the person who added them.
  const w2 = await world();
  await showWithSlots(w2);
  w2.mailer.outbox.length = 0;
  await w2.pg.query('UPDATE members SET digest_at=$1', [Date.now() - DAY]);
  await daily(w2.db, w2.mailer, ORIGIN, Date.now() + 1000);
  const benSummary = w2.mailer.outbox.find(m => m.to === 'ben@example.org' && /^Today at/.test(m.subject));
  assert.match(benSummary.html, /Coming up/);
  assert.match(benSummary.html, /Winter group show/);
  assert.ok(!w2.mailer.outbox.some(m => m.to === 'ana@example.org' && /Winter group show/.test(m.html)));

  // Calendar: the event for everyone, sign-ups for the person who took them.
  const benFeed = (await w.ben.group('feed', {})).body.feedUrl.split('feed=')[1];
  const ics = await feed(w.db, benFeed, ORIGIN, start - 5 * DAY);
  assert.match(ics, /SUMMARY:Show: Winter group show/);
  assert.match(ics, /SUMMARY:You: Gallery sitting Sat 12–3/);
  const anaFeed = (await w.ana.group('feed', {})).body.feedUrl.split('feed=')[1];
  assert.ok(!(await feed(w.db, anaFeed, ORIGIN, start - 5 * DAY)).includes('You: Gallery'));

  // Discussion.
  assert.equal((await w.ben.posts('comment', {kind: 'event', target: E, body: 'Can I bring a friend to sit?'})).status, 201);
  assert.equal((await w.ana.events('', undefined, {event: E})).body.event.comments[0].body, 'Can I bring a friend to sit?');
});

test('organizer panel overview: what needs attention', async () => {
  const w = await world();
  await w.guest.group('join', {name: 'Cara', email: 'cara@example.org'});
  const created = await w.org.call('', {title: 'March meeting', local: local(Date.now() + 5 * DAY), timezone: 'UTC'});
  await w.ana.call('rsvp', {status: 'no', reason: 'Away'}, {meeting: created.body.id});
  await w.org.call('action-add', {title: 'Late thing', owner: w.a.id, due: '2020-01-01'}, {meeting: created.body.id});
  await w.org.call('action-add', {title: 'Nobody’s', due: ''}, {meeting: created.body.id});
  await showWithSlots(w);
  assert.equal((await w.ana.groupView('organize')).body.overview, undefined, 'organizers only');
  const o = (await w.org.groupView('organize')).body;
  assert.deepEqual([o.overview.members.active, o.overview.members.requested], [3, 1]);
  assert.deepEqual([o.overview.actions.open, o.overview.actions.overdue, o.overview.actions.unowned], [2, 1, 1]);
  const m = o.overview.meetings.find(x => x.title === 'March meeting');
  assert.deepEqual([m.going, m.declined, m.noAnswer], [0, 1, 2]);
  assert.equal(o.helpWanted[0].title, 'Winter group show');
  assert.ok(o.overview.email.sent_today >= 1);
});
