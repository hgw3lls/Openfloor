import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SMTPServer} from 'smtp-server';
import {createMailer, topicsEmail} from '../lib/email.mjs';

test('Gmail-style SMTP sending: sender, headers, and per-message failures', async () => {
  const got = [];
  const server = new SMTPServer({secure: false, hideSTARTTLS: true, allowInsecureAuth: true, logger: false,
    onAuth(a, s, cb) { cb(a.username === 'me@gmail.com' && a.password === 'abcdefghijklmnop' ? null : new Error('bad'), {user: a.username}); },
    onRcptTo(address, s, cb) { cb(address.address.startsWith('reject') ? new Error('no such user') : null); },
    onData(stream, s, cb) { let d = ''; stream.on('data', c => d += c); stream.on('end', () => { got.push({to: s.envelope.rcptTo.map(r => r.address), raw: d}); cb(); }); }});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = {SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.server.address().port)};
  try {
    const meeting = {id: '604a8c47-17be-421e-81a1-02498cb607e6', title: 'Spring show', schedule: ''};
    const msgs = ['ana@example.org', 'reject@example.org', 'bo@example.org'].map(email => topicsEmail({meeting, sub: {email, token: 'a'.repeat(64)},
      base: 'https://x.test', topics: [{id: '1', label: 'Budget', detail: '', kind: 'Decision'}], subject: '1 new topic: Spring show', intro: 'Vote'}));
    const results = await createMailer(env).sendEach(msgs);
    assert.deepEqual(results.map(r => r.ok), [true, false, true], 'one bad address does not stop the rest');
    assert.deepEqual(got.map(g => g.to[0]), ['ana@example.org', 'bo@example.org']);
    assert.match(got[0].raw, /From: Tower Press Artist Group <me@gmail.com>/);
    assert.match(got[0].raw, /List-Unsubscribe:\s+<https:\/\/x.test\/api\/email\?a=unsub/);
    assert.match(got[0].raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    const wrong = await createMailer({...env, SMTP_PASS: 'wrong'}).sendEach(msgs.slice(0, 1));
    assert.equal(wrong[0].ok, false, 'a wrong app password is reported, not thrown');
  } finally { server.close(); }
});

test('no email settings means no mailer', () => {
  assert.equal(createMailer({}), null);
});

test('Resend is used when its key is set, even with the Gmail login kept for replies', async () => {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({url, auth: init.headers.Authorization, body: JSON.parse(init.body)}); return new Response('{}', {status: 200}); };
  try {
    const mailer = createMailer({RESEND_API_KEY: 're_test', EMAIL_FROM: 'Tower Press <hello@towerpress.test>', SMTP_USER: 'group@gmail.com', SMTP_PASS: 'x'});
    const plain = to => ({to, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi'});
    const msgs = [plain('a@example.org'), {...plain('b@example.org'), replyTo: 'group+k0123456789abcdef0123@gmail.com'},
      {...plain('backup@example.org'), attachments: [{filename: 'backup.json.gz', content: 'AAAA'}]}, plain('c@example.org')];
    const results = await mailer.sendEach(msgs);
    assert.deepEqual(results.map(r => r.ok), [true, true, true, true]);
    assert.deepEqual(calls.map(c => c.url), ['https://api.resend.com/emails/batch', 'https://api.resend.com/emails', 'https://api.resend.com/emails/batch'],
      'the attachment goes on its own; the rest are batched around it');
    assert.equal(calls[0].auth, 'Bearer re_test');
    assert.deepEqual(calls[0].body.map(m => [m.from, m.to[0], m.reply_to]), [
      ['Tower Press <hello@towerpress.test>', 'a@example.org', 'group@gmail.com'],
      ['Tower Press <hello@towerpress.test>', 'b@example.org', 'group+k0123456789abcdef0123@gmail.com']], 'replies still reach the Gmail inbox');
    assert.equal(calls[1].body.attachments[0].filename, 'backup.json.gz');
    assert.deepEqual(calls[2].body.map(m => m.to[0]), ['c@example.org']);
  } finally { globalThis.fetch = real; }
});
