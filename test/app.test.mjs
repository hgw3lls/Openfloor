import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member, link, visit, ORIGIN, KEY} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';
import {flush} from '../lib/outbox.mjs';
import {parseMembers} from '../lib/group.mjs';
import {calendarFile, zonedToUtc, nextOccurrence} from '../lib/schedule.mjs';

const later = (days, hourUtc = 0) => { const d = new Date(Date.now() + days * 86400000); d.setUTCHours(hourUtc, 0, 0, 0); return d; };
const localNY = date => new Intl.DateTimeFormat('sv-SE', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(date).replace(' ', 'T');

// A group with an organizer and two members; returns clients for each.
async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  return {db, pg, mailer, o, a, b, org: client(db, mailer, {session: o.session}),
    ana: client(db, mailer, {session: a.session}), ben: client(db, mailer, {session: b.session}), guest: client(db, mailer)};
}
async function newMeeting(w, fields = {}) {
  const created = await w.org.call('', {title: 'Spring show', local: localNY(later(10)), timezone: 'America/New_York', duration: '90', ...fields});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return {meeting: created.body.id};
}

test('migration: old votes and email subscribers carry over, and it can run again', async () => {
  const {pg} = await setup({legacy: async pg => {
    await pg.query("INSERT INTO meetings (id,secret,title,schedule) VALUES ('m1','s','Old','')");
    await pg.query("INSERT INTO topics (id,meeting,label,detail,kind,created) VALUES ('t1','m1','Old topic','','Update',1)");
    await pg.query("INSERT INTO votes VALUES ('m1','v1','t1','')");
  }});
  assert.equal((await pg.query('SELECT count(*)::int n FROM ballots')).rows[0].n, 1);
});

test('first organizer: setup with the organizer key signs you in', async () => {
  const {db} = await setup();
  const guest = client(db, fakeMailer());
  assert.equal((await guest.group()).body.needsSetup, true);
  assert.equal((await guest.group('setup', {organizerKey: 'wrong', name: 'Olu', email: 'o@example.org'})).status, 403);
  const ok = await guest.group('setup', {organizerKey: KEY, name: 'Olu', email: 'O@example.org'});
  assert.equal(ok.status, 200);
  const session = ok.cookie.match(/session=([a-f0-9]{64})/)[1];
  const me = await client(db, null, {session}).group();
  assert.deepEqual([me.body.me.email, me.body.me.role, me.body.needsSetup], ['o@example.org', 'organizer', false]);
});

test('sign-in by email link: opening it does nothing, the button signs in, and it works once', async () => {
  const w = await world();
  const r = await w.guest.group('signin', {email: 'ana@example.org'});
  assert.match(r.body.notice, /sign-in link is on its way/);
  assert.equal((await w.guest.group('signin', {email: 'stranger@example.org'})).body.notice, r.body.notice, 'same answer for non-members');
  assert.equal(w.mailer.outbox.length, 1, 'only members get a link');
  const url = link('signin', w.mailer.outbox[0].html);
  const opened = await visit(w.db, url);
  assert.ok(!opened.cookie, 'GET does not sign in');
  const signed = await visit(w.db, url, 'POST');
  assert.equal(signed.status, 303);
  const session = signed.cookie.match(/session=([a-f0-9]{64})/)[1];
  assert.equal((await client(w.db, null, {session}).group()).body.me.email, 'ana@example.org');
  assert.equal((await visit(w.db, url, 'POST')).status, 410, 'a link works once');
});

test('joining: request, organizer approval with a welcome email, and organizer-only controls', async () => {
  const w = await world();
  const r = await w.guest.group('join', {name: 'Cara', email: 'cara@example.org'});
  assert.match(r.body.notice, /organizer will review/);
  assert.equal(w.mailer.outbox.length, 1);
  assert.equal(w.mailer.outbox[0].to, 'org@example.org');
  assert.match(w.mailer.outbox[0].subject, /Cara wants to join/);
  const cara = (await w.org.group()).body.members.find(m => m.email === 'cara@example.org');
  assert.equal(cara.status, 'requested');
  assert.equal((await w.ana.group('approve', {member: cara.id})).status, 403, 'members cannot approve');
  w.mailer.outbox.length = 0;
  assert.equal((await w.org.group('approve', {member: cara.id})).status, 200);
  assert.match(w.mailer.outbox[0].subject, /Welcome/);
  assert.equal((await visit(w.db, link('signin', w.mailer.outbox[0].html), 'POST')).status, 303, 'welcome link signs in');

  const bot = await w.guest.group('join', {name: 'Bot', email: 'bot@example.org', website: 'spam'});
  assert.equal(bot.status, 200);
  assert.ok(!(await w.org.group()).body.members.some(m => m.email === 'bot@example.org'), 'spam trap');
});

test('organizers add people; each accepts an invitation; organizer roles are protected', async () => {
  const w = await world();
  assert.deepEqual(parseMembers('Dee Diaz <dee@example.org>\neve@example.org, Eve\nnot an email\ndee@example.org'),
    [{email: 'dee@example.org', name: 'Dee Diaz'}, {email: 'eve@example.org', name: 'Eve'}]);
  const r = await w.org.group('add', {people: 'Dee Diaz <dee@example.org>\nana@example.org'});
  assert.equal(r.body.notice, 'Invited 1 person; 1 already on the list or recently invited.');
  assert.equal(w.mailer.outbox[0].to, 'dee@example.org');
  const accept = link('confirm', w.mailer.outbox[0].html);
  assert.match((await visit(w.db, accept)).text, /Join .*\?/);
  const joined = await visit(w.db, accept, 'POST');
  assert.match(joined.text, /You’re in/);
  assert.ok(joined.cookie, 'accepting signs you in');

  const list = (await w.org.group()).body.members;
  const dee = list.find(m => m.email === 'dee@example.org'), olu = list.find(m => m.email === 'org@example.org');
  assert.equal(dee.status, 'active');
  assert.equal((await w.org.group('role', {member: olu.id, role: 'member'})).status, 409, 'cannot demote the last organizer');
  await w.org.group('role', {member: dee.id, role: 'organizer'});
  assert.equal((await w.org.group('role', {member: olu.id, role: 'member'})).status, 200, 'fine once there is another');
});

test('meetings: only organizers create them; members get an invitation with RSVP buttons', async () => {
  const w = await world();
  assert.equal((await w.ana.call('', {title: 'Nope'})).status, 403);
  await member(w.db, 'quiet@example.org', {emails: 'none'});
  const M = await newMeeting(w);
  const to = w.mailer.outbox.map(m => m.to).sort();
  assert.deepEqual(to, ['ana@example.org', 'ben@example.org', 'org@example.org'], 'members who turned email off are skipped');
  const mail = w.mailer.outbox.find(m => m.to === 'ana@example.org');
  assert.match(mail.subject, /^New meeting: Spring show/);
  assert.equal((mail.html.match(/a=rsvp/g) || []).length, 3);
  const dash = (await w.ana.group()).body.meetings.upcoming;
  assert.equal(dash[0].id, M.meeting);
  assert.equal(dash[0].mine, '');
});

test('RSVP: reasons required to decline, visible only to organizers; email RSVP is scanner-safe; nudge', async () => {
  const w = await world();
  const M = await newMeeting(w);
  assert.equal((await w.guest.call('rsvp', {status: 'yes'}, M)).status, 401, 'sign in first');
  assert.equal((await w.ana.call('rsvp', {status: 'no'}, M)).status, 400, 'decline needs a reason');
  assert.equal((await w.ana.call('rsvp', {status: 'no', reason: 'Out of town for a residency'}, M)).status, 200);
  await w.org.call('rsvp', {status: 'yes'}, M);

  const seen = (await w.ben.get(M)).body.attendance;
  assert.deepEqual(seen.going, ['Olu']);
  assert.equal(seen.declined, undefined, 'members do not see declines or reasons');
  const att = (await w.org.get(M)).body.attendance;
  assert.deepEqual(att.declined, [{name: 'Ana', reason: 'Out of town for a residency'}]);
  assert.deepEqual(att.noAnswer, ['Ben']);

  // Ben RSVPs from the invitation email.
  const benMail = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  const rsvpUrl = link('rsvp', benMail.html);
  assert.match((await visit(w.db, rsvpUrl)).text, /Can you make it/);
  assert.deepEqual((await w.org.get(M)).body.attendance.noAnswer, ['Ben'], 'opening the link saves nothing');
  assert.equal((await visit(w.db, rsvpUrl, 'POST', {status: 'no', reason: ''})).status, 400);
  assert.match((await visit(w.db, rsvpUrl, 'POST', {status: 'maybe', reason: ''})).text, /marked: Maybe/);
  assert.deepEqual((await w.org.get(M)).body.attendance.maybe, ['Ben']);

  await w.ben.call('rsvp', {status: 'yes'}, M);
  w.mailer.outbox.length = 0;
  const quiet = await member(w.db, 'late@example.org', {name: 'Lee'});
  const n = await w.org.call('nudge', {}, M);
  assert.equal(n.body.notice, 'Sending to 1 person.');
  assert.equal(w.mailer.outbox[0].to, 'late@example.org');
  assert.ok(quiet.id);
});

test('topics and voting: members only, one vote each, not on your own topic; email votes count as the same person', async () => {
  const w = await world();
  const M = await newMeeting(w);
  assert.equal((await w.guest.call('topic', {label: 'x'}, M)).status, 401);
  await w.ana.call('topic', {label: 'Budget', detail: 'Money', kind: 'Decision'}, M);
  await w.ben.call('topic', {label: 'Poster'}, M);
  const topics = (await w.ana.get(M)).body.topics;
  const budget = topics.find(t => t.label === 'Budget'), poster = topics.find(t => t.label === 'Poster');
  assert.equal(budget.own, true);
  assert.equal(budget.up, null, 'counts hidden from members');
  assert.equal((await w.ana.call('vote', {topic: budget.id, value: 1}, M)).status, 403);
  assert.equal((await w.ana.call('vote', {topic: poster.id, value: 1}, M)).status, 200);
  assert.equal((await w.guest.call('vote', {topic: poster.id, value: 1}, M)).status, 401);

  // Digest: Ana's email has buttons only on Ben's topic, and her email vote replaces her site vote.
  w.mailer.outbox.length = 0;
  const rep = await daily(w.db, w.mailer, ORIGIN);
  assert.equal(rep.digests, 1);
  const anaMail = w.mailer.outbox.find(m => m.to === 'ana@example.org');
  assert.match(anaMail.subject, /2 new topics/);
  assert.equal((anaMail.html.match(/a=vote/g) || []).length, 2);
  assert.match(anaMail.html, /Your topic/);
  const voteUrl = link('vote', anaMail.html).replace('v=1', 'v=-1');
  assert.match((await visit(w.db, voteUrl)).text, /Confirm your vote/);
  await visit(w.db, voteUrl, 'POST');
  assert.equal((await w.ana.get(M)).body.topics.find(t => t.id === poster.id).mine, -1, 'same person on site and email');
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM ballots")).rows[0].n, 1);
  const forged = link('vote', anaMail.html).replace(/topic=[^&]+/, 'topic=' + budget.id);
  assert.equal((await visit(w.db, forged, 'POST')).status, 403, 'no voting on your own topic from email either');
  assert.equal((await daily(w.db, w.mailer, ORIGIN)).digests, 0, 'topics announced once');
});

test('moderation: organizers edit, hide and delete topics; members cannot', async () => {
  const w = await world();
  const M = await newMeeting(w);
  await w.ben.call('topic', {label: 'Spam spam'}, M);
  await w.ben.call('topic', {label: 'Real topic'}, M);
  const [spam, real] = (await w.org.get(M)).body.topics;
  assert.equal((await w.ana.call('topic-hide', {topic: spam.id, hidden: true}, M)).status, 403);
  await w.org.call('topic-hide', {topic: spam.id, hidden: true}, M);
  assert.deepEqual((await w.ana.get(M)).body.topics.map(t => t.label), ['Real topic']);
  assert.equal((await w.ana.call('vote', {topic: spam.id, value: 1}, M)).status, 409);
  await w.org.call('topic-edit', {topic: real.id, label: 'Renamed', detail: 'More', kind: 'Update'}, M);
  assert.equal((await w.ana.get(M)).body.topics[0].label, 'Renamed');
  await w.org.call('topic-delete', {topic: spam.id}, M);
  assert.equal((await w.org.get(M)).body.topics.length, 1);
});

test('meeting flow: final vote email, time change, agenda, reminder, outcomes, unsubscribe', async () => {
  const w = await world();
  const M = await newMeeting(w);
  await w.ana.call('topic', {label: 'Poster'}, M);
  w.mailer.outbox.length = 0;
  assert.equal((await w.org.call('phase', {phase: 'vote'}, M)).body.notice, 'Sending to 3 people.');
  assert.match(w.mailer.outbox[0].subject, /^Vote on the topics/);
  assert.equal((await w.ana.call('topic', {label: 'late'}, M)).status, 409);

  w.mailer.outbox.length = 0;
  const start = later(12);
  const r = await w.org.call('schedule', {title: 'Spring show', local: localNY(start), timezone: 'America/New_York', duration: '90', location: 'Gallery', notify: true}, M);
  assert.equal(r.body.notice, 'Sending to 3 people.');
  assert.match(w.mailer.outbox[0].subject, /^Time changed/);
  assert.equal((await w.org.call('schedule', {local: '2026-12-03T19:00', timezone: 'Mars/Base'}, M)).status, 400);

  w.mailer.outbox.length = 0;
  assert.equal((await w.org.call('agenda', {agenda: [{label: 'Poster', minutes: 20, kind: 'Decision'}]}, M)).body.notice, 'Sending to 3 people.');
  assert.match(w.mailer.outbox[0].html, /api\/calendar\?meeting=/);
  assert.match(w.mailer.outbox[0].html, /a=rsvp/);
  w.mailer.outbox.length = 0;
  await w.org.call('agenda', {agenda: [{label: 'Poster', minutes: 25}]}, M);
  assert.equal(w.mailer.outbox.length, 0, 'agenda emailed once');

  const s = (await w.org.get(M)).body.startsAt;
  w.mailer.outbox.length = 0;
  assert.equal((await daily(w.db, w.mailer, ORIGIN, Date.parse(s) - 48 * 3600000)).reminders, 0);
  assert.equal((await daily(w.db, w.mailer, ORIGIN, Date.parse(s) - 20 * 3600000)).reminders, 1);
  assert.match(w.mailer.outbox[0].subject, /^Reminder/);
  assert.equal((await daily(w.db, w.mailer, ORIGIN, Date.parse(s) - 10 * 3600000)).reminders, 0);

  assert.equal((await w.org.call('email', {kind: 'outcomes'}, M)).status, 400);
  await w.org.call('notes', {notes: 'Ana books the room'}, M);
  w.mailer.outbox.length = 0;
  await w.org.call('email', {kind: 'outcomes'}, M);
  const anaMail = w.mailer.outbox.find(m => m.to === 'ana@example.org');
  assert.ok(anaMail.headers['List-Unsubscribe-Post']);
  const unsub = link('unsub', anaMail.html);
  assert.match((await visit(w.db, unsub)).text, /Stop emails\?/);
  await visit(w.db, unsub, 'POST');
  w.mailer.outbox.length = 0;
  await w.org.call('email', {kind: 'outcomes'}, M);
  assert.ok(!w.mailer.outbox.some(m => m.to === 'ana@example.org'), 'unsubscribed member skipped');
  assert.equal((await w.ana.group()).body.me.emails, 'none', 'but still a member');

  const row = (await w.pg.query('SELECT * FROM meetings WHERE id=$1', [M.meeting])).rows[0];
  const ics = calendarFile(row, ORIGIN + '/#' + row.id);
  assert.match(ics, /LOCATION:Gallery/);
  assert.ok(ics.split('\r\n').every(l => l.length <= 75));
});

test('repeating meetings: the next one is created and announced after the meeting ends, once', async () => {
  const w = await world();
  const M = await newMeeting(w, {repeat: 'weekly'});
  const s = Date.parse((await w.org.get(M)).body.startsAt);
  w.mailer.outbox.length = 0;
  assert.equal((await daily(w.db, w.mailer, ORIGIN, s + 3600000)).created, 0, 'not while it is still on');
  const rep = await daily(w.db, w.mailer, ORIGIN, s + 3 * 3600000);
  assert.equal(rep.created, 1);
  const upcoming = (await w.ana.group()).body.meetings.upcoming;
  assert.ok(upcoming.some(m => Date.parse(m.startsAt) === s + 7 * 86400000 || Math.abs(Date.parse(m.startsAt) - s - 7 * 86400000) === 3600000), 'a week later, same local time');
  assert.ok(w.mailer.outbox.some(m => /^New meeting/.test(m.subject)));
  assert.equal((await daily(w.db, w.mailer, ORIGIN, s + 4 * 3600000)).created, 0, 'only once');
  assert.equal(nextOccurrence(new Date('2026-10-30T23:00:00Z'), 'America/New_York', 'weekly').toISOString(), '2026-11-07T00:00:00.000Z', 'keeps 7 pm across daylight saving');
  assert.equal(nextOccurrence(new Date('2026-12-30T00:00:00Z'), 'America/New_York', 'monthly').toISOString(), '2027-01-27T00:00:00.000Z', 'a 5th Tuesday becomes the last Tuesday');
  assert.equal(zonedToUtc('2026-07-01T09:30', 'Europe/Berlin').toISOString(), '2026-07-01T07:30:00.000Z');
});

test('outbox: failed sends are retried; over-budget mail waits instead of being dropped', async () => {
  const w = await world();
  w.mailer.failNext = 1;
  await w.guest.group('signin', {email: 'ana@example.org'});
  assert.equal(w.mailer.outbox.length, 0, 'first attempt failed');
  assert.deepEqual(await flush(w.db, w.mailer), {sent: 1, failed: 0});
  process.env.EMAIL_DAILY_LIMIT = '1';
  try {
    await w.guest.group('signin', {email: 'ben@example.org'});
    assert.equal(w.mailer.outbox.length, 1, 'budget used up: waits');
    assert.equal((await w.pg.query("SELECT count(*)::int n FROM outbox WHERE status='queued'")).rows[0].n, 1);
  } finally { delete process.env.EMAIL_DAILY_LIMIT; }
});

test('rate limits on sign-in requests', async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) assert.equal((await w.guest.group('signin', {email: 'ana@example.org'})).status, 200);
  assert.equal((await w.guest.group('signin', {email: 'ana@example.org'})).status, 429);
});

test('old organizer links keep working for their own meeting', async () => {
  const w = await world();
  const M = await newMeeting(w);
  const {secret} = (await w.pg.query('SELECT secret FROM meetings WHERE id=$1', [M.meeting])).rows[0];
  assert.equal((await w.guest.call('notes', {notes: 'x'}, {...M, secret: secret.slice(0, -1) + '0'})).status, 403);
  assert.equal((await w.guest.call('notes', {notes: 'x'}, {...M, secret})).status, 200);
});
