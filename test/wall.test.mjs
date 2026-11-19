import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member} from './helpers.mjs';

const DAY = 86400000;
const local = ms => new Date(ms).toISOString().slice(0, 16);

test('the wall gets what needs the member: unvoted topics, open slots with people, open calls', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  const [org, ana, ben] = [o, a, b].map(m => client(db, mailer, {session: m.session}));
  const M = (await org.call('', {title: 'March meeting', local: local(Date.now() + 5 * DAY), timezone: 'UTC'})).body.id;
  await org.call('topic', {label: 'Budget'}, {meeting: M});
  await ana.call('topic', {label: 'Ana’s idea'}, {meeting: M});
  await org.call('topic', {label: 'Hidden one'}, {meeting: M});
  const hidden = (await org.get({meeting: M})).body.topics.find(t => t.label === 'Hidden one').id;
  await org.call('topic-hide', {topic: hidden, hidden: true}, {meeting: M});
  const E = (await org.events('create', {title: 'Winter show', local: local(Date.now() + 9 * DAY), timezone: 'UTC'})).body.id;
  await org.events('slot-add', {event: E, label: 'Sitting', capacity: 2});
  await org.calls('create', {title: 'Zine fund', deadline: new Date(Date.now() + 12 * DAY).toISOString().slice(0, 10)});

  let wall = (await ana.group()).body;
  assert.deepEqual(wall.topics.map(t => t.label), ['Budget'], 'not my own topic, not hidden ones');
  assert.equal(wall.meetings.upcoming[0].topics, 2);
  assert.deepEqual(wall.slots.map(s => [s.label, s.capacity, s.people, s.mine]), [['Sitting', 2, [], false]]);
  assert.deepEqual(wall.openCalls.map(c => c.title), ['Zine fund']);
  assert.deepEqual(wall.upcomingEvents.map(e => e.title), ['Winter show']);

  await ana.call('vote', {topic: wall.topics[0].id, value: 1}, {meeting: M});
  await ana.events('claim', {slot: wall.slots[0].id});
  wall = (await ana.group()).body;
  assert.equal(wall.topics.length, 0, 'voted topics leave the list');
  assert.deepEqual([wall.slots[0].people, wall.slots[0].mine], [['Ana'], true]);
  assert.deepEqual((await ben.group()).body.topics.map(t => t.label), ['Budget', 'Ana’s idea']);

  // Feature switches apply here too.
  await org.group('features', {topics: 'view', signups: 'off', calls: 'off'});
  wall = (await ben.group()).body;
  assert.deepEqual([wall.topics, wall.slots, wall.openCalls], [[], [], []]);
  assert.deepEqual((await org.group()).body.topics.map(t => t.label), ['Ana’s idea'], 'organizers still get everything (but not their own topics)');
});

test('the member directory: everyone active, names and roles, no email addresses', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  await member(db, 'gone@example.org', {name: 'Gone', status: 'removed'});
  await member(db, 'cara.lee@example.org');
  const res = await client(db, mailer, {session: a.session}).groupView('directory');
  assert.deepEqual(res.body.directory.map(m => [m.name, m.role, m.me]), [['Ana', 'member', true], ['cara.lee', 'member', false], ['Olu', 'organizer', false]]);
  assert.ok(!JSON.stringify(res.body.directory).includes('@'), 'no email addresses');
  assert.equal((await client(db, mailer).groupView('directory')).body.directory, undefined, 'members only');
});

test('profiles: members set their medium, organizers set role labels; both show in the directory', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const [org, ana] = [o, a].map(m => client(db, mailer, {session: m.session}));
  assert.equal((await ana.group('profile', {name: 'Ana Ribeiro', medium: 'Screenprint', emails: 'all', digest: 'daily'})).status, 200);
  assert.equal((await ana.group('title', {member: a.id, title: 'Treasurer'})).status, 403, 'organizers only');
  assert.equal((await org.group('title', {member: a.id, title: 'Committee'})).status, 200);
  const me = (await ana.group()).body.me;
  assert.deepEqual([me.name, me.medium, me.title], ['Ana Ribeiro', 'Screenprint', 'Committee']);
  assert.ok(me.since > 0);
  const dir = (await ana.groupView('directory')).body.directory;
  assert.deepEqual(dir.map(m => [m.name, m.medium, m.title]), [['Ana Ribeiro', 'Screenprint', 'Committee'], ['Olu', '', '']]);
  await ana.group('profile', {name: 'Ana Ribeiro', emails: 'all', digest: 'daily'});
  assert.equal((await ana.group()).body.me.medium, 'Screenprint', 'leaving medium out keeps it');
  await org.group('title', {member: a.id, title: ''});
  assert.equal((await ana.group()).body.me.title, '');
});

test('In today: check in and out; it lasts 12 hours; shows on the wall and in the directory', async () => {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  const [ana, ben] = [a, b].map(m => client(db, mailer, {session: m.session}));
  assert.deepEqual((await ben.group()).body.inToday, []);
  assert.equal((await ana.group('checkin', {in: true})).status, 200);
  assert.deepEqual((await ben.group()).body.inToday, [{name: 'Ana', me: false}]);
  assert.deepEqual((await ana.group()).body.inToday, [{name: 'Ana', me: true}]);
  assert.deepEqual((await ben.groupView('directory')).body.directory.map(m => [m.name, m.inToday]), [['Ana', true], ['Ben', false]]);
  await pg.query('UPDATE checkins SET at=$1', [Date.now() - 13 * 3600000]);
  assert.deepEqual((await ben.group()).body.inToday, [], 'gone after 12 hours');
  await ana.group('checkin', {in: true});
  await ana.group('checkin', {in: false});
  assert.deepEqual((await ben.group()).body.inToday, [], 'checked out');
});
