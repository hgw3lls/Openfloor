import test from 'node:test';
import assert from 'node:assert/strict';
import {ORIGIN, client, fakeMailer, link, member, setup} from './helpers.mjs';
import {links} from '../lib/links.mjs';
import {flush} from '../lib/outbox.mjs';

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  return {db, pg, mailer, org: client(db, mailer, {session: o.session}), guest: client(db, mailer)};
}
const welcomes = (w, to) => w.mailer.outbox.filter(m => m.to === to && /^Welcome to/.test(m.subject));
const tap = (w, url) => links(new Request(url, {method: 'POST'}), w.db, Date.now(), w.mailer);

test('welcome: an approved join request gets one email with the guide and the sign-in link', async () => {
  const w = await world();
  await w.org.group('features', {posts: 'off'});
  await w.guest.group('join', {name: 'Cara', email: 'cara@example.org'});
  const cara = (await w.org.group()).body.members.find(m => m.email === 'cara@example.org');
  w.mailer.outbox.length = 0;
  await w.org.group('approve', {member: cara.id});
  assert.equal(w.mailer.outbox.length, 1, 'the welcome replaces the old sign-in email');
  const mail = w.mailer.outbox[0];
  assert.equal(mail.subject, 'Welcome to Tower Press Artist Group');
  assert.match(mail.html, /request to join .* was approved/);
  for (const part of ['The wall', 'Meetings', 'Replying by email', 'Your emails']) assert.match(mail.text, new RegExp(part.toUpperCase()));
  assert.doesNotMatch(mail.text, /board/i, 'posts are off, so the board isn’t mentioned');
  assert.match(mail.text, /EVENTS AND CALLS\n/);
  assert.equal((await tap(w, link('signin', mail.html))).status, 303, 'its link signs in');
});

test('welcome: accepting an invitation sends it once; existing members and organizers are told what applies', async () => {
  const w = await world();
  await w.org.group('add', {people: 'Dee <dee@example.org>'});
  const accept = link('confirm', w.mailer.outbox.find(m => m.to === 'dee@example.org').html);
  assert.match(await (await tap(w, accept)).text(), /You’re in/);
  await flush(w.db, w.mailer);
  assert.equal(welcomes(w, 'dee@example.org').length, 1);
  assert.match(welcomes(w, 'dee@example.org')[0].text, /Open the wall: https:\/\/floor\.test\//);
  assert.doesNotMatch(welcomes(w, 'dee@example.org')[0].text, /YOU’RE AN ORGANIZER/);
  await tap(w, accept); await flush(w.db, w.mailer);
  assert.equal(welcomes(w, 'dee@example.org').length, 1, 'only once');

  await w.org.group('add', {people: 'fay@example.org', role: 'organizer'});
  const fay = w.mailer.outbox.find(m => m.to === 'fay@example.org');
  await tap(w, link('confirm', fay.html)); await flush(w.db, w.mailer);
  assert.match(welcomes(w, 'fay@example.org')[0].text, /YOU’RE AN ORGANIZER/);
});

test('welcome: signing in with a code for the first time counts as joining', async () => {
  const w = await world();
  await member(w.db, 'gus@example.org', {status: 'invited'});
  await w.guest.group('signin', {email: 'gus@example.org'});
  const code = w.mailer.outbox.find(m => m.to === 'gus@example.org').text.match(/code[^:]*: (\d{6})/)[1];
  assert.equal((await w.guest.group('code', {email: 'gus@example.org', code})).status, 200);
  assert.equal(welcomes(w, 'gus@example.org').length, 1);
});

test('welcome: no email set up means nothing is queued or marked', async () => {
  const w = await world();
  await w.org.group('add', {people: 'hal@example.org'});
  const token = (await w.pg.query("SELECT token FROM members WHERE email='hal@example.org'")).rows[0].token;
  await links(new Request(`${ORIGIN}/api/email?a=confirm&t=${token}`, {method: 'POST'}), w.db);
  assert.equal((await w.pg.query("SELECT welcomed FROM members WHERE email='hal@example.org'")).rows[0].welcomed, 0);
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM outbox WHERE recipient='hal@example.org' AND message LIKE '%Welcome to%'")).rows[0].n, 0);
});
