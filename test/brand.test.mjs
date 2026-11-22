import test from 'node:test';
import assert from 'node:assert/strict';
import {KEY, ORIGIN, client, fakeMailer, link, member, setup, visit} from './helpers.mjs';
import {group} from '../lib/group.mjs';
import {flush} from '../lib/outbox.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  return {db, pg, mailer, org: client(db, mailer, {session: o.session}), ana: client(db, mailer, {session: a.session}), guest: client(db, mailer)};
}
const logoGet = (w, slot, v = '1') => group(new Request(`${ORIGIN}/api/group?logo=${slot}&v=${v}`), w.db, KEY);
// An email the organizer sends to members, after the outbox has sent it.
async function meetingMail(w) {
  w.mailer.outbox.length = 0;
  await w.org.call('', {title: 'Spring show', local: '2030-04-01T18:00', timezone: 'America/New_York', duration: '90'});
  await flush(w.db, w.mailer);
  return w.mailer.outbox.find(m => m.to === 'ana@example.org');
}

test('logo: off by default, so the name is text everywhere', async () => {
  const w = await world();
  assert.deepEqual((await w.guest.group()).body.branding, {wide: '', square: ''});
  assert.deepEqual((await w.org.group()).body.brandingAdmin, {on: false, wide: '', square: ''});
  assert.equal((await w.ana.group()).body.brandingAdmin, undefined, 'members don’t get the organizer settings');
  const mail = await meetingMail(w);
  assert.doesNotMatch(mail.html, /<img/);
  assert.match(mail.html, /Tower Press Artist Group<!--\/logo-->/);
  assert.equal((await logoGet(w, 'wide')).status, 404);
});

test('logo: organizers upload images; only real images within the size limit; members can’t', async () => {
  const w = await world();
  assert.equal((await w.ana.group('branding', {wide: PNG, on: true})).status, 403);
  assert.equal((await w.org.group('branding', {wide: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='})).status, 400, 'no SVG');
  assert.equal((await w.org.group('branding', {wide: PNG.replace('image/png', 'image/jpeg')})).status, 400, 'the bytes must match the type');
  const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(520 * 1024)]).toString('base64');
  assert.ok([400, 413].includes((await w.org.group('branding', {wide: big})).status), 'over 500 KB');

  const up = await w.org.group('branding', {wide: PNG});
  assert.equal(up.status, 200);
  const admin = (await w.org.group()).body.brandingAdmin;
  assert.equal(admin.on, false, 'uploading doesn’t switch it on');
  assert.match(admin.wide, /^\/api\/group\?logo=wide&v=\d+$/);
  const image = await logoGet(w, 'wide');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.match(image.headers.get('Cache-Control'), /immutable/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PNG.split(',')[1], 'base64'));
  assert.deepEqual((await w.guest.group()).body.branding, {wide: '', square: ''}, 'still off for everyone');
  assert.doesNotMatch((await meetingMail(w)).html, /<img/);
});

test('logo: switched on, it replaces the name on the site, in emails and on email-link pages; off or removed, the name is back', async () => {
  const w = await world();
  await w.org.group('branding', {wide: PNG});
  await w.org.group('branding', {square: PNG});
  await w.org.group('branding', {on: true});
  const site = (await w.guest.group()).body.branding;
  assert.match(site.wide, /logo=wide/);
  assert.match(site.square, /logo=square/, 'the sign-in page can show the badge');

  const mail = await meetingMail(w);
  assert.match(mail.html, /<img src="https:\/\/floor\.test\/api\/group\?logo=wide&amp;v=\d+" alt="Tower Press Artist Group"/);
  assert.doesNotMatch(mail.html, /rotate\(-12deg\)/, 'the text mark is gone');
  const page = await visit(w.db, link('rsvp', mail.html));
  assert.match(page.text, /<p class="logo"><img src="\/api\/group\?logo=wide&amp;v=\d+"/);

  await w.org.group('branding', {on: false});
  assert.doesNotMatch((await meetingMail(w)).html, /<img/);
  assert.doesNotMatch((await visit(w.db, link('rsvp', mail.html))).text, /<img/);

  await w.org.group('branding', {on: true});
  await w.org.group('branding', {remove: 'wide'});
  assert.equal((await logoGet(w, 'wide')).status, 404);
  assert.equal((await w.guest.group()).body.branding.wide, '');
  assert.doesNotMatch((await meetingMail(w)).html, /<img/, 'on but nothing uploaded: still text');
});
