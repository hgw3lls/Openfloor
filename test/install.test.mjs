import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {setup, fakeMailer, client, member} from './helpers.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';

test('the app can be saved to a phone: manifest, icons and page tags', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const icon of manifest.icons) assert.ok(existsSync(new URL('../public' + icon.src, import.meta.url)), icon.src);
  assert.ok(manifest.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const tag of ['rel="manifest"', 'rel="apple-touch-icon"', 'apple-mobile-web-app-capable', 'name="theme-color"']) assert.ok(html.includes(tag), tag);
  assert.ok(existsSync(new URL('../public/apple-touch-icon.png', import.meta.url)));
});

test('sign in by typing the 6-digit code from the email (for the home-screen app)', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  await member(db, 'ana@example.org', {name: 'Ana'});
  const guest = client(db, mailer);
  await guest.group('signin', {email: 'ana@example.org'});
  const mail = mailer.outbox.find(m => m.to === 'ana@example.org');
  const code = mail.text.match(/code where you asked to sign in: (\d{6})/)[1];
  assert.match(mail.html, new RegExp(code));
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  assert.equal((await guest.group('code', {email: 'ana@example.org', code: wrong})).status, 400);
  assert.equal((await guest.group('code', {email: 'ben@example.org', code})).status, 400, 'tied to the address');
  const ok = await guest.group('code', {email: 'ANA@example.org', code: code.slice(0, 3) + ' ' + code.slice(3)});
  assert.equal(ok.status, 200);
  const session = ok.cookie.match(/session=([a-f0-9]{64})/)[1];
  assert.equal((await client(db, mailer, {session}).group()).body.me.email, 'ana@example.org');
  assert.equal((await guest.group('code', {email: 'ana@example.org', code})).status, 400, 'works once');

  // Guessing is limited: five tries an hour per address.
  await guest.group('signin', {email: 'ana@example.org'});
  const fresh = mailer.outbox.at(-1).text.match(/sign in: (\d{6})/)[1];
  for (let i = 0; i < 3; i++) await guest.group('code', {email: 'ana@example.org', code: '000000' === fresh ? '111111' : '000000'});
  assert.equal((await guest.group('code', {email: 'ana@example.org', code: fresh})).status, 429);
});
