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
