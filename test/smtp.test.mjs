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
