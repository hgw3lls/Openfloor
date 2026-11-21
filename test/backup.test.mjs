import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {setup, fakeMailer, client, member} from './helpers.mjs';
import {backupData, restoreData, weeklyBackup} from '../lib/backup.mjs';

const SUNDAY = Date.parse('2026-11-22T16:00:00Z');

test('weekly backup: emailed on Sundays with a gzipped copy, once a day, no secrets', async () => {
  const {db} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  await client(db, mailer, {session: o.session}).call('', {title: 'December', local: '2026-12-04T18:30', timezone: 'UTC'});
  mailer.outbox.length = 0;
  const env = {SMTP_USER: 'towerpress@gmail.com'};
  assert.equal((await weeklyBackup(db, mailer, {now: SUNDAY - 86400000, env})).skipped, 'not Sunday');
  assert.equal((await weeklyBackup(db, mailer, {now: SUNDAY, env})).sent, true);
  assert.equal((await weeklyBackup(db, mailer, {now: SUNDAY + 3600000, env})).skipped, 'already sent');
  assert.equal(mailer.outbox.length, 1);
  const mail = mailer.outbox[0];
  assert.equal(mail.to, 'towerpress@gmail.com');
  const data = JSON.parse(gunzipSync(Buffer.from(mail.attachments[0].content, 'base64')));
  assert.equal(data.tables.members[0].email, 'org@example.org');
  assert.equal(data.tables.meetings[0].title, 'December');
  assert.equal(data.tables.members[0].token, undefined, 'no email-link tokens');
  assert.equal(data.tables.meetings[0].secret, undefined, 'no organizer links');
  for (const t of ['sessions', 'signin_codes', 'outbox', 'rate_counts']) assert.equal(data.tables[t], undefined, t);
});

test('a failed backup email is tried again on the next run', async () => {
  const {db} = await setup();
  const mailer = fakeMailer(); mailer.failNext = 1;
  const env = {SMTP_USER: 'towerpress@gmail.com'};
  assert.ok((await weeklyBackup(db, mailer, {now: SUNDAY, env})).failed);
  assert.equal((await weeklyBackup(db, mailer, {now: SUNDAY + 60000, env})).sent, true);
});

test('restore puts everything back into an empty database, with new secret links', async () => {
  const a = await setup(), mailer = fakeMailer();
  const o = await member(a.db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const ana = await member(a.db, 'ana@example.org', {name: 'Ana'});
  const org = client(a.db, mailer, {session: o.session});
  const M = (await org.call('', {title: 'December', local: '2026-12-04T18:30', timezone: 'UTC'})).body.id;
  await client(a.db, mailer, {session: ana.session}).call('rsvp', {status: 'yes', reason: ''}, {meeting: M});
  await client(a.db, mailer, {session: ana.session}).posts('create', {title: 'Paper order', body: 'Who needs Somerset?'});
  const data = JSON.parse(JSON.stringify(await backupData(a.db)));

  const b = await setup();
  await restoreData(b.db, data);
  const again = JSON.parse(JSON.stringify(await backupData(b.db)));
  assert.deepEqual(again.tables, data.tables, 'the same content comes back');
  const token = (await b.db.prepare('SELECT token FROM members WHERE email=?').bind('ana@example.org').first()).token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, ana.token, 'old email links don’t work');
  await assert.rejects(restoreData(b.db, {tables: {}}), /isn’t a Tower Press backup/);
});

test('organizers can download a full backup; members can’t', async () => {
  const {db} = await setup();
  const {exportData} = await import('../lib/export.mjs');
  const o = await member(db, 'org@example.org', {role: 'organizer'}), m = await member(db, 'm@example.org');
  const get = s => exportData(new Request('https://floor.test/api/export?what=backup', {headers: {Cookie: 'session=' + s}}), db);
  const ok = await get(o.session);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).tables.members.length, 2);
  assert.equal((await get(m.session)).status, 403);
});
