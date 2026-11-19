import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member, ORIGIN} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';
import {emailActions} from '../lib/actions.mjs';
import {pollInbox, processMessage, replyText, shortcut, senderVerified} from '../lib/replies.mjs';
import {csv, exportData} from '../lib/export.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';

const PASS = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass (google.com: domain designates) smtp.mailfrom=x@example.org; dmarc=pass (p=NONE) header.from=example.org';
let n = 0;
const raw = ({from, to, body, auth = PASS, headers = ''}) =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: Re: something\r\nAuthentication-Results: ${auth}\r\nMessage-ID: <m${++n}@example.org>\r\n${headers}Content-Type: text/plain; charset=utf-8\r\n\r\n${body.replace(/\n/g, '\r\n')}\r\n`;
const local = d => new Intl.DateTimeFormat('sv-SE', {timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(d).replace(' ', 'T');

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  const w = {db, pg, mailer, o, a, b, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}), ben: client(db, mailer, {session: b.session})};
  w.reply = (from, to, body, extra) => processMessage(db, raw({from, to, body, ...extra}), emailActions(db, {mailer, base: ORIGIN}));
  return w;
}

test('reply text: quoted email, signatures and phone footers are removed', () => {
  assert.equal(replyText('Sounds good!\n\nOn Tue, Dec 1, 2026 at 7:00 PM Tower Press <x@gmail.com> wrote:\n> old text'), 'Sounds good!');
  assert.equal(replyText('Yes\nOn Tue, Dec 1, 2026 at 7:00 PM Tower Press <\nx@gmail.com> wrote:\n> old'), 'Yes');
  assert.equal(replyText('Count me in\n\nSent from my iPhone'), 'Count me in');
  assert.equal(replyText('Thanks\n-- \nAna Ruiz\nPainter'), 'Thanks');
  assert.equal(replyText('Agree\n> quoted\n>> more'), 'Agree');
  assert.equal(replyText('Hi\n\n________________________________\nFrom: Tower Press\nSent: Monday'), 'Hi');
});

test('reply shortcuts: votes, RSVPs and new topics', () => {
  assert.deepEqual(shortcut('topic', '+1'), {vote: 1, comment: ''});
  assert.deepEqual(shortcut('topic', '-1\nNot this month'), {vote: -1, comment: 'Not this month'});
  assert.deepEqual(shortcut('topic', 'I think we should'), {comment: 'I think we should'});
  assert.deepEqual(shortcut('meeting', 'Yes!'), {rsvp: 'yes', reason: ''});
  assert.deepEqual(shortcut('meeting', 'No, because I am traveling'), {rsvp: 'no', reason: 'I am traveling'});
  assert.deepEqual(shortcut('meeting', "Can't make it, sorry"), {rsvp: 'no', reason: 'sorry'});
  assert.equal(shortcut('meeting', 'no').reason, 'Replied “no” by email without a reason.');
  assert.deepEqual(shortcut('meeting', 'maybe - depends on work'), {rsvp: 'maybe', reason: 'depends on work'});
  assert.deepEqual(shortcut('meeting', 'New topic: Zine fair\nShould we table?'), {topic: {label: 'Zine fair', detail: 'Should we table?'}});
  assert.deepEqual(shortcut('meeting', 'Can I bring a friend?'), {comment: 'Can I bring a friend?'}, 'a question is a comment, not a no');
  assert.deepEqual(shortcut('post', 'yes'), {comment: 'yes'}, 'shortcuts only where they make sense');
});

test('sender verification uses Gmail’s checks', () => {
  assert.equal(senderVerified(PASS, 'ana@example.org'), true);
  assert.equal(senderVerified('mx.google.com; dkim=pass header.i=@example.org; spf=neutral', 'ana@example.org'), true);
  assert.equal(senderVerified('mx.google.com; spf=pass smtp.mailfrom=bob@evil.org; dmarc=fail', 'ana@example.org'), false);
  assert.equal(senderVerified('mx.google.com; spf=fail; dkim=none; dmarc=fail', 'ana@example.org'), false);
  assert.equal(senderVerified(undefined, 'ana@example.org'), false);
});

test('replying to a meeting email: RSVP, new topic and discussion; strangers and robots are ignored', async () => {
  const w = await world();
  const created = await w.org.call('', {title: 'Spring show', local: local(new Date(Date.now() + 10 * 86400000)), timezone: 'UTC'});
  const M = {meeting: created.body.id};
  const invite = to => w.mailer.outbox.find(m => m.to === to && /^New meeting/.test(m.subject));
  const anaReply = invite('ana@example.org').replyTo, benReply = invite('ben@example.org').replyTo;
  assert.match(anaReply, /^towerpress\+k[a-f0-9]{20}@gmail\.com$/);
  assert.notEqual(anaReply, benReply, 'personal reply addresses');
  assert.match(invite('ana@example.org').text, /Or just reply to this email/);

  assert.equal(await w.reply('Ana <ana@example.org>', anaReply, 'No, because I am at a residency\n\nOn Mon, Tower Press wrote:\n> invite'), 'rsvp: ok');
  assert.equal(await w.reply('ben@example.org', benReply, 'New topic: Zine fair\nShould we table at it?'), 'topic: ok');
  assert.equal(await w.reply('ben@example.org', benReply, 'Can someone bring the projector?'), 'comment: ok');

  const view = (await w.org.get(M)).body;
  assert.deepEqual(view.attendance.declined, [{name: 'Ana', reason: 'I am at a residency'}]);
  assert.equal(view.topics[0].label, 'Zine fair');
  assert.equal(view.topics[0].detail, 'Should we table at it?');
  assert.deepEqual(view.discussion.map(c => [c.author, c.body, c.via]), [['Ben', 'Can someone bring the projector?', 'email']]);
  assert.equal((await w.ben.get(M)).body.topics[0].own, true, 'a topic sent by email is still yours');

  assert.equal(await w.reply('eve@evil.org', anaReply, 'yes'), 'ignored: sender is not the member');
  assert.equal(await w.reply('ana@example.org', anaReply, 'yes', {auth: 'mx.google.com; spf=fail; dmarc=fail'}), 'ignored: sender not verified');
  assert.equal(await w.reply('ana@example.org', anaReply, 'I am out of office', {headers: 'Auto-Submitted: auto-replied\r\n'}), 'ignored: automatic message');
  assert.equal(await w.reply('ana@example.org', 'towerpress@gmail.com', 'hello'), 'ignored: no reply key');
  assert.equal(await w.reply('ana@example.org', 'towerpress+k0000000000aaaaaaaaaa@gmail.com', 'yes'), 'ignored: unknown key');
  assert.equal((await w.org.get(M)).body.attendance.declined.length, 1, 'nothing changed');
});

test('posts: everyone right-away gets them at once, others in their summary; replies by email become comments', async () => {
  const w = await world();
  await w.pg.query("UPDATE members SET digest='instant' WHERE email='ben@example.org'");
  const p = await w.ana.posts('create', {title: 'Open call: winter print fair', body: 'Deadline Dec 15.\nWho wants to apply together?'});
  assert.equal(p.status, 201);
  assert.deepEqual(w.mailer.outbox.map(m => m.to), ['ben@example.org'], 'only “everything right away” members, never the author');
  const mail = w.mailer.outbox[0];
  assert.equal(mail.subject, 'Open call: winter print fair');
  assert.ok(mail.replyTo);

  // Ben replies from his inbox.
  w.mailer.outbox.length = 0;
  assert.equal(await w.reply('ben@example.org', mail.replyTo, 'I’m in! I can do the application text.\n\nSent from my phone'), 'comment: ok');
  const thread = (await w.ana.posts('', undefined, {post: p.body.id})).body.post;
  assert.deepEqual(thread.comments.map(c => [c.author, c.body, c.via]), [['Ben', 'I’m in! I can do the application text.', 'email']]);
  assert.equal(w.mailer.outbox.length, 0, 'Ben is the only right-away member, and it was his reply');

  // Next day: the organizer (daily) gets a summary with the post and Ben's reply; Ben (right away) gets none.
  w.mailer.outbox.length = 0;
  await w.pg.query('UPDATE members SET digest_at=$1', [Date.now() - 86400000]);
  const rep = await daily(w.db, w.mailer, ORIGIN, Date.now() + 1000);
  assert.ok(rep.digests >= 1);
  const summary = w.mailer.outbox.find(m => m.to === 'org@example.org' && /^Today at/.test(m.subject));
  assert.match(summary.html, /Open call: winter print fair/);
  assert.match(summary.html, /I’m in!/);
  assert.match(summary.html, /mailto:towerpress\+k/);
  assert.ok(!w.mailer.outbox.some(m => m.to === 'ben@example.org' && /^Today at/.test(m.subject)));
  const anaSummary = w.mailer.outbox.find(m => m.to === 'ana@example.org' && /^Today at/.test(m.subject));
  assert.match(anaSummary.html, /I’m in!/, 'Ana sees Ben’s reply on her post');
  assert.ok(!/New posts/.test(anaSummary.html), 'but not her own post as new');

  // Permissions.
  assert.equal((await w.ben.posts('pin', {post: p.body.id, pinned: true})).status, 403);
  assert.equal((await w.org.posts('pin', {post: p.body.id, pinned: true})).status, 200);
  assert.equal((await w.ana.posts()).body.posts[0].pinned, true);
  assert.equal((await w.org.posts('hide', {post: p.body.id, hidden: true})).status, 200);
  assert.equal((await w.ben.posts()).body.posts.length, 0, 'hidden from members');
  assert.equal((await w.ben.posts('delete', {post: p.body.id})).status, 403);
  assert.equal((await w.ana.posts('delete', {post: p.body.id})).status, 200, 'authors can delete their own post');
  assert.equal((await client(w.db, null).posts()).status, 401, 'members only');
});

test('weekly summaries go out on Mondays only', async () => {
  const w = await world();
  await w.pg.query("UPDATE members SET digest='weekly', digest_at=$1", [Date.now() - 8 * 86400000]);
  await w.ana.posts('create', {title: 'Studio clean-up Saturday'});
  const tuesday = Date.parse('2030-01-01T17:00:00Z'), monday = Date.parse('2030-01-07T17:00:00Z');
  await w.pg.query('UPDATE posts SET created=$1', [tuesday - 3600000]);
  await w.pg.query('UPDATE members SET digest_at=$1', [tuesday - 8 * 86400000]);
  w.mailer.outbox.length = 0;
  assert.equal((await daily(w.db, w.mailer, ORIGIN, tuesday)).digests, 0);
  const rep = await daily(w.db, w.mailer, ORIGIN, monday);
  assert.equal(rep.digests, 2, 'organizer and Ben; not Ana, who wrote it');
  assert.match(w.mailer.outbox.find(m => /^This week/.test(m.subject)).html, /Studio clean-up/);
});

test('export: organizers only, and cells can’t run as spreadsheet formulas', async () => {
  const w = await world();
  await w.pg.query("UPDATE members SET name='=HYPERLINK(\"http://evil\")' WHERE email='ben@example.org'");
  assert.equal(csv([['=1+1', 'plain', 'say "hi"']]), '﻿"\'=1+1","plain","say ""hi"""\r\n');
  const get = (session, what) => exportData(new Request(ORIGIN + '/api/export?what=' + what, {headers: session ? {Cookie: 'session=' + session} : {}}), w.db);
  assert.equal((await get(w.a.session, 'members')).status, 403);
  const res = await get(w.o.session, 'members');
  assert.match(res.headers.get('Content-Disposition'), /tower-press-members/);
  const text = await res.text();
  assert.match(text, /"ana@example.org"/);
  assert.match(text, /"'=HYPERLINK/);
});

test('inbox: reads unread replies, acts on them, marks them read, and waits 4 minutes between checks', async () => {
  const w = await world();
  const created = await w.org.call('', {title: 'Spring show', local: local(new Date(Date.now() + 10 * 86400000)), timezone: 'UTC'});
  const to = w.mailer.outbox.find(m => m.to === 'ana@example.org').replyTo;
  const box = {messages: new Map([[11, raw({from: 'ana@example.org', to, body: 'yes'})], [12, raw({from: 'ana@example.org', to, body: 'See you there'})]]), seen: []};
  class FakeImap {
    async connect() {} async logout() {}
    async getMailboxLock() { return {release() {}}; }
    async search(query) { assert.deepEqual(query, {seen: false, to: '+k'}); return [...box.messages.keys()]; }
    async fetchOne(uid) { return {source: Buffer.from(box.messages.get(Number(uid)))}; }
    async messageFlagsAdd(uid, flags) { box.seen.push([Number(uid), flags]); }
  }
  const act = emailActions(w.db, {mailer: w.mailer, base: ORIGIN});
  const report = await pollInbox(w.db, act, {Imap: FakeImap});
  assert.deepEqual(report.done, ['rsvp: ok', 'comment: ok']);
  assert.deepEqual(box.seen, [[11, ['\\Seen']], [12, ['\\Seen']]]);
  const view = (await w.org.get({meeting: created.body.id})).body;
  assert.deepEqual(view.attendance.going, ['Ana']);
  assert.equal(view.discussion[0].body, 'See you there');
  assert.deepEqual(await pollInbox(w.db, act, {Imap: FakeImap}), {skipped: 'polled recently'});
  assert.equal((await pollInbox(w.db, act, {Imap: FakeImap, now: Date.now() + 5 * 60000})).read, 2, 'checks again after 4 minutes');
});

test('posts: tags and +1 (toggle, counts, view-only blocks it)', async () => {
  const {setup, fakeMailer, client, member} = await import('./helpers.mjs');
  const {db} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const [org, ana] = [o, a].map(m => client(db, mailer, {session: m.session}));
  const P = (await ana.posts('create', {title: 'Spare A2 drum?', tag: 'Kit'})).body.id;
  const Q = (await ana.posts('create', {title: 'Untagged', tag: 'Nonsense'})).body.id;
  let list = (await org.posts()).body;
  assert.deepEqual(list.tags, ['General', 'Studio', 'Kit', 'Shows', 'Swap']);
  assert.deepEqual(Object.fromEntries(list.posts.map(p => [p.title, p.tag])), {'Spare A2 drum?': 'Kit', 'Untagged': 'General'});
  assert.equal((await org.posts('plus', {post: P, plus: true})).status, 200);
  await org.posts('plus', {post: P, plus: true});
  await ana.posts('plus', {post: P, plus: true});
  list = (await org.posts()).body.posts;
  assert.deepEqual([list.find(p => p.id === P).plus, list.find(p => p.id === P).myPlus], [2, true]);
  await org.posts('plus', {post: P, plus: false});
  const one = (await org.posts('', undefined, {post: P})).body.post;
  assert.deepEqual([one.tag, one.plus, one.myPlus], ['Kit', 1, false]);
  await org.group('features', {posts: 'view'});
  assert.equal((await ana.posts('plus', {post: Q, plus: true})).status, 403, 'view-only can’t +1');
});
