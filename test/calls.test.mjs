import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member, link, visit, ORIGIN} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';
import {flush} from '../lib/outbox.mjs';
import {feed} from '../lib/feed.mjs';
import {remindCalls} from '../lib/calls.mjs';
import {emailActions} from '../lib/actions.mjs';
import {processMessage} from '../lib/replies.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';
const DAY = 86400000;
const PASS = 'mx.google.com; dkim=pass header.i=@example.org; dmarc=pass header.from=example.org';
let n = 0;
const raw = (from, to, body) => `From: ${from}\r\nTo: ${to}\r\nSubject: Re\r\nAuthentication-Results: ${PASS}\r\nMessage-ID: <c-${++n}@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const day = (offset, base = Date.now()) => new Date(base + offset * DAY).toISOString().slice(0, 10);

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  return {db, pg, mailer, o, a, b, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}), ben: client(db, mailer, {session: b.session}), guest: client(db, mailer)};
}
async function share(w, extra = {}) {
  const r = await w.ana.calls('create', {title: 'Spring print residency', kind: 'Residency', organization: 'Arts council', deadline: day(20), link: 'https://example.org/apply', award: '$2,000', ...extra});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

test('calls: members only; any member shares; only the author or an organizer changes it', async () => {
  const w = await world();
  assert.equal((await w.guest.calls()).status, 401);
  assert.equal((await w.ana.calls('create', {title: 'x', deadline: 'soon'})).status, 400);
  assert.equal((await w.ana.calls('create', {title: 'x', deadline: day(3), link: 'javascript:alert(1)'})).status, 400, 'only web links');
  assert.equal((await w.ana.calls('create', {title: '', deadline: day(3)})).status, 400);
  const C = await share(w);
  await share(w, {title: 'Old show', deadline: day(-2)});
  const list = (await w.ben.calls()).body;
  assert.deepEqual(list.open.map(c => c.title), ['Spring print residency']);
  assert.deepEqual(list.closed.map(c => c.title), ['Old show']);
  assert.ok(list.kinds.includes('Grant'));
  assert.equal((await w.ben.calls('update', {call: C, title: 'Mine'})).status, 403);
  assert.equal((await w.ben.calls('delete', {call: C})).status, 403);
  assert.equal((await w.org.calls('update', {call: C, award: '$2,500'})).status, 200, 'organizers can edit');
  const view = (await w.ben.calls('', undefined, {call: C})).body.call;
  assert.deepEqual([view.title, view.award, view.author, view.canEdit], ['Spring print residency', '$2,500', 'Ana', false]);
  assert.equal((await w.ana.calls('', undefined, {call: C})).body.call.canEdit, true);
  assert.equal((await w.ana.calls('hide', {call: C, hidden: true})).status, 403, 'only organizers hide');
  await w.org.calls('hide', {call: C, hidden: true});
  assert.equal((await w.ben.calls()).body.open.length, 0, 'hidden from members');
  assert.equal((await w.ben.calls('', undefined, {call: C})).status, 404);
  assert.equal((await w.org.calls()).body.open.length, 1, 'organizers still see it');
});

test('interest from the site and from email links (scanner-safe); new calls go to instant members', async () => {
  const w = await world();
  await w.pg.query("UPDATE members SET digest='instant' WHERE email='ben@example.org'");
  const C = await share(w);
  const mail = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  assert.ok(mail, 'instant members hear right away');
  assert.equal(w.mailer.outbox.filter(m => m.to === 'ana@example.org').length, 0, 'not the person who shared it');
  assert.ok(!w.mailer.outbox.some(m => m.to === 'org@example.org'), 'daily members wait for the summary');
  assert.match(mail.subject, /Spring print residency/);
  const url = link('call', mail.html);
  assert.match((await visit(w.db, url)).text, /Mark me as/);
  assert.equal((await w.ben.calls('', undefined, {call: C})).body.call.myStatus, '', 'opening the link changes nothing');
  assert.match((await visit(w.db, url, 'POST')).text, /Saved: Interested/);
  assert.equal((await w.ben.calls('', undefined, {call: C})).body.call.myStatus, 'interested');

  assert.equal((await w.ana.calls('interest', {call: C, status: 'applying'})).status, 200);
  assert.equal((await w.ana.calls('interest', {call: C, status: 'maybe'})).status, 400);
  const view = (await w.org.calls('', undefined, {call: C})).body.call;
  assert.deepEqual(view.people, {interested: ['Ben'], applying: ['Ana'], applied: []});
  assert.equal((await w.org.calls()).body.open[0].applying, 1);
  await w.ben.calls('interest', {call: C, status: 'none'});
  assert.deepEqual((await w.org.calls('', undefined, {call: C})).body.call.people.interested, []);

  // Dashboard: the member's own marked calls come first.
  const D = await share(w, {title: 'Sooner grant', kind: 'Grant', deadline: day(5)});
  await w.ben.calls('interest', {call: C, status: 'interested'});
  assert.deepEqual((await w.ben.group()).body.deadlines.map(c => c.title), ['Spring print residency', 'Sooner grant']);
  assert.ok(D);
});

test('deadline reminders a week and a day before, once each, not after applying; summaries and calendars', async () => {
  const w = await world();
  const base = Date.parse('2030-03-01T16:00:00Z');
  const C = await share(w, {deadline: '2030-03-20'});
  await w.ben.calls('interest', {call: C, status: 'interested'});
  await w.ana.calls('interest', {call: C, status: 'applying'});
  await w.org.calls('interest', {call: C, status: 'applied'});
  const run = async at => { w.mailer.outbox.length = 0; await remindCalls(w.db, w.mailer, ORIGIN, at); await flush(w.db, w.mailer, {now: at}); return w.mailer.outbox.map(m => m.to + ' ' + m.subject).sort(); };
  assert.deepEqual(await run(base), []);
  const week = await run(base + 12 * DAY);
  assert.equal(week.length, 2, week.join('\n'));
  assert.ok(week.every(s => !s.startsWith('org@')), 'not to people who already applied');
  assert.deepEqual(await run(base + 13 * DAY), [], 'once');
  assert.equal((await run(base + 18 * DAY)).length, 2, 'a day before');
  assert.deepEqual(await run(base + 18.5 * DAY), []);

  // Moving the deadline resets reminders.
  await w.ana.calls('update', {call: C, deadline: '2030-03-25'});
  assert.equal((await run(base + 18.5 * DAY)).length, 2, 'week reminder again for the new date');

  // Calendar: deadlines of calls you marked.
  const benFeed = (await w.ben.group('feed', {})).body.feedUrl.split('feed=')[1];
  assert.match(await feed(w.db, benFeed, ORIGIN, base), /SUMMARY:Deadline: Spring print residency/);
  await w.ben.calls('interest', {call: C, status: 'none'});
  assert.ok(!(await feed(w.db, benFeed, ORIGIN, base)).includes('Deadline: Spring'));

  // Summaries list new calls, but not to the person who shared them.
  const w2 = await world();
  await share(w2);
  w2.mailer.outbox.length = 0;
  await w2.pg.query('UPDATE members SET digest_at=$1', [Date.now() - DAY]);
  await daily(w2.db, w2.mailer, ORIGIN, Date.now() + 1000);
  const benSummary = w2.mailer.outbox.find(m => m.to === 'ben@example.org' && /^Today at/.test(m.subject));
  assert.match(benSummary.html, /New open calls/);
  assert.match(benSummary.html, /Spring print residency/);
  assert.ok(!w2.mailer.outbox.some(m => m.to === 'ana@example.org' && /Spring print residency/.test(m.html)));
});

test('discussion on the site and by email reply; deleting removes everything', async () => {
  const w = await world();
  await w.pg.query("UPDATE members SET digest='instant' WHERE email='ben@example.org'");
  const C = await share(w);
  const mail = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  assert.match(mail.replyTo, /^towerpress\+k/);
  const act = emailActions(w.db, {mailer: w.mailer, base: ORIGIN});
  assert.equal(await processMessage(w.db, raw('ben@example.org', mail.replyTo, 'Anyone want to apply together?'), act), 'comment: ok');
  assert.equal((await w.ana.posts('comment', {kind: 'call', target: C, body: 'Yes!'})).status, 201);
  assert.deepEqual((await w.org.calls('', undefined, {call: C})).body.call.comments.map(c => [c.author, c.body, c.via]),
    [['Ben', 'Anyone want to apply together?', 'email'], ['Ana', 'Yes!', 'web']]);
  await w.ben.calls('interest', {call: C, status: 'applying'});
  assert.equal((await w.org.calls('delete', {call: C})).status, 200, 'organizers can delete');
  assert.equal((await w.ben.calls('', undefined, {call: C})).status, 404);
  for (const t of ['calls', 'call_interest', 'comments']) assert.equal((await w.pg.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 0, t);
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM reply_keys WHERE kind='call'")).rows[0].n, 0);
});

test('calls: who, results and a private application checklist per member', async () => {
  const w = await world();
  const C = await share(w, {eligibility: 'Printmakers in the region', results: 'Mid January', needs: 'CV, one page\n\nArtist statement, 300 words\n6 images of recent work\n'});
  let c = (await w.ben.calls('', undefined, {call: C})).body.call;
  assert.deepEqual([c.eligibility, c.results, c.needs, c.myChecks], ['Printmakers in the region', 'Mid January', ['CV, one page', 'Artist statement, 300 words', '6 images of recent work'], []]);
  assert.equal((await w.ben.calls('check', {call: C, item: 0, done: true})).status, 200);
  await w.ben.calls('check', {call: C, item: 2, done: true});
  assert.equal((await w.ben.calls('check', {call: C, item: 5, done: true})).status, 400);
  assert.deepEqual((await w.ben.calls('', undefined, {call: C})).body.call.myChecks, [0, 2]);
  assert.deepEqual((await w.ana.calls('', undefined, {call: C})).body.call.myChecks, [], 'private to each member');
  await w.ben.calls('check', {call: C, item: 0, done: false});
  assert.deepEqual((await w.ben.calls('', undefined, {call: C})).body.call.myChecks, [2]);
  await w.ana.calls('update', {call: C, results: 'February'});
  assert.deepEqual((await w.ben.calls('', undefined, {call: C})).body.call.myChecks, [2], 'other edits keep checklists');
  await w.ana.calls('update', {call: C, needs: 'CV\nStatement'});
  assert.deepEqual((await w.ben.calls('', undefined, {call: C})).body.call.myChecks, [], 'a new list starts afresh');
  await w.org.group('features', {calls: 'view'});
  assert.equal((await w.ben.calls('check', {call: C, item: 0, done: true})).status, 403);
});
