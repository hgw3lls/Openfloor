// Each test here reproduces a problem found in the November review.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup, fakeMailer, client, member, visit, ORIGIN} from './helpers.mjs';
import {allow} from '../lib/limits.mjs';
import {enqueue, flush} from '../lib/outbox.mjs';
import {setFeatures} from '../lib/features.mjs';
import {claimSlot} from '../lib/events.mjs';
import {createShortCode} from '../lib/auth.mjs';
import {emailActions} from '../lib/actions.mjs';
import {processMessage, senderVerified} from '../lib/replies.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';
const DAY = 86400000;
const local = ms => new Date(ms).toISOString().slice(0, 16);

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  return {db, pg, mailer, o, a, b, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}),
    ben: client(db, mailer, {session: b.session}), guest: client(db, mailer)};
}

test('rate limits hold when many requests arrive at once', async () => {
  const {db} = await setup();
  const results = await Promise.all(Array.from({length: 40}, () => allow(db, 'burst', 5, 3600000)));
  assert.equal(results.filter(Boolean).length, 5);
});

test('6-digit codes: guesses sent at once are capped, and too many wrong ones burn the real code', async () => {
  const w = await world();
  const code = await createShortCode(w.db, w.a.id);
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  const guesses = await Promise.all(Array.from({length: 30}, (_, i) =>
    client(w.db, w.mailer, {ip: '198.51.100.' + i}).group('code', {email: 'ana@example.org', code: wrong})));
  assert.equal(guesses.filter(r => r.status === 400).length, 5, 'only five guesses are checked');
  const right = await w.guest.group('code', {email: 'ana@example.org', code});
  assert.notEqual(right.status, 200, 'the real code no longer works after the guesses');
});

test('the outbox marks each email as it goes, so a cut-off run doesn’t resend', async () => {
  const {db} = await setup();
  await enqueue(db, '', [1, 2, 3].map(i => ({to: `m${i}@example.org`, subject: 's', text: 't'})));
  const delivered = [];
  const dies = {async sendEach(messages, {onResult} = {}) {
    for (const [i, m] of messages.entries()) {
      if (i === 2) throw new Error('function timed out');
      delivered.push(m.to); await onResult?.(i, {ok: true});
    }
  }};
  await flush(db, dies).catch(() => {});
  const later = Date.now() + 11 * 60000, again = fakeMailer();
  await flush(db, again, {now: later});
  assert.deepEqual(again.outbox.map(m => m.to), ['m3@example.org'], 'only the unsent one goes again');
});

test('the outbox gives up on a message stuck in “sending” after its last try', async () => {
  const {db} = await setup();
  await enqueue(db, '', [{to: 'x@example.org', subject: 's', text: 't'}]);
  await db.prepare("UPDATE outbox SET status='sending', attempts=5, updated=0").bind().run();
  const mailer = fakeMailer();
  await flush(db, mailer);
  assert.equal(mailer.outbox.length, 0);
  assert.equal((await db.prepare('SELECT status FROM outbox').bind().first()).status, 'dead');
});

test('the outbox stops when its time is up and leaves the rest queued', async () => {
  const {db} = await setup();
  await enqueue(db, '', [1, 2].map(i => ({to: `m${i}@example.org`, subject: 's', text: 't'})));
  const slow = {async sendEach(messages, {onResult, stop}) {
    const out = [];
    for (const [i] of messages.entries()) { const r = stop() ? {ok: false, skipped: true} : {ok: true}; out.push(r); await onResult(i, r); }
    return out;
  }};
  const report = await flush(db, slow, {budgetMs: -1});
  assert.equal(report.sent, 0);
  const rows = (await db.prepare('SELECT status,attempts FROM outbox').bind().all()).results;
  assert.deepEqual(rows.map(r => [r.status, r.attempts]), [['queued', 0], ['queued', 0]]);
});

test('email vote and RSVP links follow the same rules as the site', async () => {
  const w = await world();
  const M = (await w.org.call('', {title: 'December', local: local(Date.now() + 10 * DAY), timezone: 'UTC'})).body.id;
  await w.ben.call('topic', {label: 'Press fund', detail: '', kind: 'Discussion'}, {meeting: M});
  const topic = (await w.db.prepare('SELECT id FROM topics').bind().first()).id;
  await setFeatures(w.db, {topics: 'view'});
  const voted = await visit(w.db, `${ORIGIN}/api/email?a=vote&t=${w.a.token}&topic=${topic}&v=1`, 'POST');
  assert.equal(voted.status, 403, 'view-only topics can’t be voted on by email');
  assert.equal((await w.db.prepare('SELECT COUNT(*)::integer AS n FROM ballots').bind().first()).n, 0);
  const rsvp = await visit(w.db, `${ORIGIN}/api/email?a=rsvp&t=${w.a.token}&m=${M}`, 'POST', {status: 'yes'});
  assert.equal(rsvp.status, 200);
  assert.equal((await w.db.prepare('SELECT status FROM rsvps WHERE member=?').bind(w.a.id).first()).status, 'yes');
});

test('the join form never activates an invited member, and keeps to the sign-in limit', async () => {
  const w = await world();
  const invited = await member(w.db, 'ivy@example.org', {status: 'invited', role: 'organizer'});
  for (let i = 0; i < 8; i++) await client(w.db, w.mailer, {ip: '198.51.100.' + i}).group('join', {email: 'ivy@example.org', name: 'Ivy'});
  assert.equal((await w.db.prepare('SELECT status FROM members WHERE id=?').bind(invited.id).first()).status, 'invited');
  assert.equal(w.mailer.outbox.filter(m => m.to === 'ivy@example.org').length, 5, 'at most five sign-in emails an hour');
});

test('sign-in and invite links ignore a POST from another site', async () => {
  const w = await world();
  const signin = await links(w.db, `${ORIGIN}/api/email?a=confirm&t=${w.a.token}`, {'sec-fetch-site': 'cross-site'});
  assert.equal(signin.cookie, null, 'no session from a cross-site form');
  const same = await links(w.db, `${ORIGIN}/api/email?a=confirm&t=${w.a.token}`, {'sec-fetch-site': 'same-origin'});
  assert.match(same.cookie, /session=/);
});
async function links(db, url, headers) {
  const {links: handler} = await import('../lib/links.mjs');
  const r = await handler(new Request(url, {method: 'POST', headers}), db);
  return {status: r.status, cookie: r.headers.get('Set-Cookie')};
}

test('a removed member’s sign-ups free up the slot', async () => {
  const w = await world();
  const E = (await w.ana.events('create', {title: 'Show', local: local(Date.now() + 5 * DAY), timezone: 'UTC'})).body.id;
  await w.ana.events('slot-add', {event: E, label: 'Door', capacity: 1});
  const slot = (await w.db.prepare('SELECT id FROM slots').bind().first()).id;
  assert.equal((await claimSlot(w.db, w.b.id, slot)).ok, true);
  // Removed earlier, before the clean-up existed: the claim is still there.
  await w.db.prepare("UPDATE members SET status='removed' WHERE id=?").bind(w.b.id).run();
  assert.equal((await claimSlot(w.db, w.a.id, slot)).ok, true, 'a removed member doesn’t hold the place');
  const c = await member(w.db, 'cy@example.org');
  assert.equal((await w.org.group('remove', {member: w.a.id})).status, 200);
  assert.equal((await w.db.prepare('SELECT COUNT(*)::integer AS n FROM claims WHERE member=?').bind(w.a.id).first()).n, 0, 'removing clears their claims');
  assert.equal((await claimSlot(w.db, c.id, slot)).ok, true);
});

test('a slot never ends up over capacity when people sign up at once', async () => {
  const w = await world();
  const E = (await w.ana.events('create', {title: 'Show', local: local(Date.now() + 5 * DAY), timezone: 'UTC'})).body.id;
  await w.ana.events('slot-add', {event: E, label: 'Door', capacity: 2});
  const slot = (await w.db.prepare('SELECT id FROM slots').bind().first()).id;
  const people = await Promise.all(Array.from({length: 8}, (_, i) => member(w.db, `p${i}@example.org`)));
  await Promise.all(people.map(p => claimSlot(w.db, p.id, slot)));
  assert.ok((await w.db.prepare('SELECT COUNT(*)::integer AS n FROM claims').bind().first()).n <= 2);
});

test('a forged “dmarc=pass” below Gmail’s own header isn’t believed', async () => {
  const gmail = 'mx.google.com; spf=fail smtp.mailfrom=evil.org; dkim=none; dmarc=fail header.from=example.org';
  const forged = 'mx.google.com; dmarc=pass header.from=example.org';
  assert.equal(senderVerified([gmail, forged], 'ana@example.org'), false);
  assert.equal(senderVerified(['mx.google.com; dmarc=pass header.from=evil.org'], 'ana@example.org'), false, 'DMARC must be for the sender’s domain');
  assert.equal(senderVerified(['evil.example; dmarc=pass header.from=example.org'], 'ana@example.org'), false, 'only Gmail’s results count');

  const w = await world();
  const M = (await w.org.call('', {title: 'December', local: local(Date.now() + 10 * DAY), timezone: 'UTC'})).body.id;
  const to = w.mailer.outbox.find(m => m.to === 'ana@example.org').replyTo;
  const raw = `Authentication-Results: ${gmail}\r\nFrom: ana@example.org\r\nTo: ${to}\r\nAuthentication-Results: ${forged}\r\nSubject: Re\r\nMessage-ID: <f1@x>\r\n\r\nYes\r\n`;
  assert.equal(await processMessage(w.db, raw, emailActions(w.db, {mailer: w.mailer, base: ORIGIN})), 'ignored: sender not verified');
  assert.equal((await w.db.prepare('SELECT COUNT(*)::integer AS n FROM rsvps WHERE meeting=?').bind(M).first()).n, 0);
});

test('the same reply read twice is only handled once', async () => {
  const w = await world();
  await w.org.call('', {title: 'December', local: local(Date.now() + 10 * DAY), timezone: 'UTC'});
  const to = w.mailer.outbox.find(m => m.to === 'ben@example.org').replyTo;
  const raw = `Authentication-Results: mx.google.com; dmarc=pass header.from=example.org\r\nFrom: ben@example.org\r\nTo: ${to}\r\nSubject: Re\r\nMessage-ID: <same@x>\r\n\r\nWho has the key?\r\n`;
  const act = emailActions(w.db, {mailer: w.mailer, base: ORIGIN});
  assert.equal(await processMessage(w.db, raw, act), 'comment: ok');
  assert.equal(await processMessage(w.db, raw, act), 'ignored: already handled');
  assert.equal((await w.db.prepare('SELECT COUNT(*)::integer AS n FROM comments').bind().first()).n, 1);
});

test('proposals made at the same moment get different numbers', async () => {
  const w = await world();
  const make = (c, i) => c.proposals('create', {title: 'Idea ' + i, kind: 'Other', summary: 'A plan for the group', reason: 'Because', effect: 'Better', days: 7});
  const made = await Promise.all([w.ana, w.ben, w.org, w.ana, w.ben].map(make));
  assert.ok(made.every(r => r.status === 201), JSON.stringify(made.map(r => r.body)));
  const numbers = made.map(r => r.body.number);
  assert.equal(new Set(numbers).size, 5);
});

test('a call is open until its deadline day ends everywhere (anywhere on Earth)', async () => {
  const w = await world();
  const late = Date.parse('2026-12-02T06:00:00Z'); // 2 Dec in UTC, still 1 Dec in UTC−12
  assert.equal((await w.ana.calls('create', {title: 'Print grant', kind: 'Grant', deadline: '2026-12-01'})).status, 201);
  const {listCalls} = await import('../lib/calls.mjs');
  const list = await listCalls(w.db, {id: w.a.id, role: 'member'}, late);
  assert.equal(list.open.length, 1, JSON.stringify(list));
});

test('a meeting page shows no names, notes, actions or topics to someone not signed in', async () => {
  const w = await world();
  const M = (await w.org.call('', {title: 'December', local: local(Date.now() + 10 * DAY), timezone: 'UTC'})).body.id;
  await w.ana.call('rsvp', {status: 'yes', reason: ''}, {meeting: M});
  await w.ben.call('topic', {label: 'Press fund', detail: 'private', kind: 'Discussion'}, {meeting: M});
  const view = (await w.guest.get({meeting: M})).body;
  assert.equal(view.title, 'December');
  assert.deepEqual(view.attendance.going, []);
  assert.deepEqual(view.topics, []);
  assert.deepEqual(view.actions, []);
});

test('an organizer link alone can’t suggest a topic (and doesn’t crash)', async () => {
  const w = await world();
  const M = (await w.org.call('', {title: 'December', local: local(Date.now() + 10 * DAY), timezone: 'UTC'})).body.id;
  const {secret} = await w.db.prepare('SELECT secret FROM meetings WHERE id=?').bind(M).first();
  const r = await w.guest.call('topic', {label: 'x', detail: '', kind: 'Discussion'}, {meeting: M, secret});
  assert.equal(r.status, 401);
});

test('deleting a topic deletes its discussion and reply addresses', async () => {
  const w = await world();
  const M = (await w.org.call('', {title: 'December', local: local(Date.now() + 10 * DAY), timezone: 'UTC'})).body.id;
  await w.ben.call('topic', {label: 'Press fund', detail: '', kind: 'Discussion'}, {meeting: M});
  const topic = (await w.db.prepare('SELECT id FROM topics').bind().first()).id;
  await w.ana.posts('comment', {kind: 'topic', target: topic, body: 'Yes please'});
  await w.db.prepare("INSERT INTO reply_keys (key,member,kind,target,created) VALUES ('k1',?, 'topic', ?, 0)").bind(w.a.id, topic).run();
  assert.equal((await w.org.call('topic-delete', {topic}, {meeting: M})).status, 200);
  assert.equal((await w.db.prepare("SELECT COUNT(*)::integer AS n FROM comments WHERE target=?").bind(topic).first()).n, 0);
  assert.equal((await w.db.prepare("SELECT COUNT(*)::integer AS n FROM reply_keys WHERE target=?").bind(topic).first()).n, 0);
});

test('full volunteer slots stay readable', () => {
  const css = readFileSync(new URL('../public/wall.css', import.meta.url), 'utf8');
  const opacity = Number(/\.n-slot\.full\{opacity:([\d.]+)\}/.exec(css)?.[1] ?? 1);
  assert.ok(opacity >= 0.75);
});

test('the wall sheet escapes the meeting place', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /body:esc\(\[clock\(d\)\+\(m\.location/);
});
