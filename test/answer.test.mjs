import test from 'node:test';
import assert from 'node:assert/strict';
import {ORIGIN, client, fakeMailer, link, member, setup, visit} from './helpers.mjs';
import {daily} from '../lib/cron.mjs';

const later = days => { const d = new Date(Date.now() + days * 86400000); d.setUTCHours(0, 0, 0, 0); return d; };
const localNY = date => new Intl.DateTimeFormat('sv-SE', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(date).replace(' ', 'T');

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  const w = {db, pg, mailer, a, b, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}), ben: client(db, mailer, {session: b.session})};
  const created = await w.org.call('', {title: 'Spring show', local: localNY(later(10)), timezone: 'America/New_York', duration: '90'});
  w.M = {meeting: created.body.id};
  return w;
}
const answerLink = (w, to) => link('answer', w.mailer.outbox.find(m => m.to === to).html);

test('answer form: the invite links to one form; opening it saves nothing', async () => {
  const w = await world();
  const mail = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  assert.match(mail.html, /Answer in one form/);
  assert.match(mail.text, /a=answer/);
  await w.ana.call('topic', {label: 'Budget'}, w.M);
  const page = await visit(w.db, answerLink(w, 'ben@example.org'));
  assert.equal(page.status, 200);
  for (const part of ['Can you make it?', 'Vote on the topics', 'Budget', 'Suggest a topic', 'Add to the discussion']) assert.ok(page.text.includes(part), part);
  assert.deepEqual((await w.org.get(w.M)).body.attendance.noAnswer.sort(), ['Ana', 'Ben', 'Olu']);
  assert.equal((await w.pg.query('SELECT count(*)::int n FROM ballots')).rows[0].n, 0);
});

test('answer form: one send saves the RSVP, votes, a new topic and a comment', async () => {
  const w = await world();
  await w.ana.call('topic', {label: 'Budget'}, w.M);
  await w.ben.call('topic', {label: 'Poster'}, w.M);
  const topics = (await w.ben.get(w.M)).body.topics;
  const budget = topics.find(t => t.label === 'Budget'), poster = topics.find(t => t.label === 'Poster');
  const url = answerLink(w, 'ben@example.org');
  const form = await visit(w.db, url);
  assert.ok(!form.text.includes(`name="v:${poster.id}"`), 'no voting on your own topic');
  assert.match(form.text, /Your topic/);

  const res = await visit(w.db, url, 'POST', {status: 'yes', ['v:' + budget.id]: '-1', ['v:' + poster.id]: '1', label: 'Zine fair', detail: 'Tables?', comment: 'Bringing prints'});
  assert.equal(res.status, 200);
  assert.match(res.text, /RSVP: Going/);
  assert.match(res.text, /1 vote/);
  assert.match(res.text, /Your topic: Zine fair/);
  assert.match(res.text, /Your comment/);
  const view = (await w.ben.get(w.M)).body;
  assert.deepEqual(view.attendance.going, ['Ben']);
  assert.equal(view.topics.find(t => t.id === budget.id).mine, -1);
  assert.ok(view.topics.some(t => t.label === 'Zine fair' && t.own));
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM ballots WHERE topic=$1", [poster.id])).rows[0].n, 0, 'the forged own-topic vote is ignored');
  assert.equal((await w.pg.query("SELECT body FROM comments WHERE kind='meeting' AND target=$1", [w.M.meeting])).rows[0].body, 'Bringing prints');

  // Opening it again shows the saved answers, and sending nothing new changes nothing.
  const again = await visit(w.db, url);
  assert.match(again.text, /value="yes" checked/);
  assert.match(again.text, new RegExp(`name="v:${budget.id}" value="-1" checked`));
  assert.match((await visit(w.db, url, 'POST', {status: 'yes', ['v:' + budget.id]: '-1'})).text, /Nothing changed/);
  const removed = await visit(w.db, url, 'POST', {status: 'yes', ['v:' + budget.id]: '0'});
  assert.match(removed.text, /1 vote/);
  assert.equal((await w.pg.query('SELECT count(*)::int n FROM ballots')).rows[0].n, 0);
});

test('answer form: declining needs a reason; an empty form says so; typed text is kept', async () => {
  const w = await world();
  const url = answerLink(w, 'ana@example.org');
  const noReason = await visit(w.db, url, 'POST', {status: 'no', comment: 'Hello'});
  assert.equal(noReason.status, 400);
  assert.match(noReason.text, /say why/);
  assert.match(noReason.text, />Hello</, 'the comment is kept');
  assert.equal((await w.pg.query('SELECT count(*)::int n FROM comments')).rows[0].n, 0, 'nothing saved');
  assert.equal((await visit(w.db, url, 'POST', {})).status, 400);
  assert.match((await visit(w.db, url, 'POST', {status: 'no', reason: 'Away that week'})).text, /RSVP: Can’t make it/);
});

test('answer form: after the agenda only RSVP and comments; features that are off are left out; the digest links it', async () => {
  const w = await world();
  await w.ana.call('topic', {label: 'Budget'}, w.M);
  w.mailer.outbox.length = 0;
  await daily(w.db, w.mailer, ORIGIN);
  const digest = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  assert.match(digest.html, /a=answer/);

  await w.org.group('features', {comments: 'off'});
  let page = (await visit(w.db, link('answer', digest.html))).text;
  assert.ok(!page.includes('Add to the discussion'), 'comments are off');
  assert.ok(page.includes('Vote on the topics'));

  await w.pg.query("UPDATE meetings SET phase='agenda' WHERE id=$1", [w.M.meeting]);
  page = (await visit(w.db, link('answer', digest.html))).text;
  assert.ok(!page.includes('Vote on the topics') && !page.includes('Suggest a topic'), 'voting and topics are closed');
  assert.ok(page.includes('Can you make it?'));
});
