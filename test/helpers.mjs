import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {wrap} from '../lib/db.mjs';
import {meetings} from '../lib/meetings.mjs';
import {links} from '../lib/links.mjs';
import {group} from '../lib/group.mjs';
import {posts} from '../lib/posts.mjs';
import {events} from '../lib/events.mjs';
import {calls} from '../lib/calls.mjs';
import {proposals} from '../lib/proposals.mjs';
import {newToken, startSession} from '../lib/auth.mjs';

export const ORIGIN = 'https://floor.test', KEY = 'orgkey';

export async function setup({legacy} = {}) {
  const pg = new PGlite();
  const db = wrap(async (text, values) => { const r = await pg.query(text, values); return {rows: r.rows, rowCount: r.affectedRows ?? r.rows.length}; });
  const statements = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8').split(';').map(s => s.trim()).filter(Boolean);
  if (legacy) { for (const s of statements.slice(0, 3)) await pg.query(s); await legacy(pg); }
  for (const s of statements) await pg.query(s);
  return {pg, db, statements};
}

// A fake mailer: records what would be sent. failNext makes the next sends fail.
export function fakeMailer() {
  const outbox = [];
  const mailer = {outbox, failNext: 0, async sendEach(messages) {
    return messages.map(m => {
      if (mailer.failNext > 0) { mailer.failNext--; return {ok: false, error: 'EFAKE'}; }
      outbox.push(m); return {ok: true};
    });
  }};
  return mailer;
}

// Creates a member directly and returns their session cookie value.
export async function member(db, email, {role = 'member', status = 'active', name = '', emails = 'all'} = {}) {
  const id = crypto.randomUUID(), token = newToken();
  await db.prepare('INSERT INTO members (id,email,name,role,status,emails,token,created) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, email, name, role, status, emails, token, Date.now()).run();
  const cookie = await startSession(db, id);
  return {id, email, token, session: cookie.match(/session=([a-f0-9]{64})/)[1]};
}

export function client(db, mailer, {session, ip = '203.0.113.1'} = {}) {
  const pending = [];
  const defer = promise => pending.push(promise);
  async function send(handler, path, params, payload, extra = {}) {
    const headers = {Origin: ORIGIN, 'x-forwarded-for': ip, ...extra};
    if (session) headers.Cookie = 'session=' + session;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const res = await handler(new Request(ORIGIN + path + '?' + new URLSearchParams(params), {method: payload === undefined ? 'GET' : 'POST', headers,
      body: payload === undefined ? undefined : JSON.stringify(payload)}), db, KEY, mailer, defer);
    await Promise.all(pending.splice(0));
    return {status: res.status, body: await res.json(), cookie: res.headers.get('Set-Cookie')};
  }
  const call = (action, payload, {meeting = '', secret} = {}) =>
    send(meetings, '/api/meeting', {meeting, action}, payload, secret ? {Authorization: 'Bearer ' + secret} : {});
  const postsHandler = (request, db, key, mailer, defer) => posts(request, db, mailer, defer);
  return {call, get: (meeting = {}) => call(undefined, undefined, meeting), group: (action = '', payload) => send(group, '/api/group', {action}, payload),
    posts: (action = '', payload, params = {}) => send(postsHandler, '/api/posts', {action, ...params}, payload),
    events: (action = '', payload, params = {}) => send((request, db, key, mailer, defer) => events(request, db, mailer, defer), '/api/events', {action, ...params}, payload),
    calls: (action = '', payload, params = {}) => send((request, db, key, mailer, defer) => calls(request, db, mailer, defer), '/api/calls', {action, ...params}, payload),
    proposals: (action = '', payload, params = {}) => send((request, db, key, mailer, defer) => proposals(request, db, mailer, defer), '/api/proposals', {action, ...params}, payload),
    groupView: view => send(group, '/api/group', {view}, undefined)};
}

export const link = (a, html) => html.match(new RegExp('href="([^"]*a=' + a + '[^"]*)"'))[1].replaceAll('&amp;', '&');
export async function visit(db, url, method = 'GET', form) {
  const init = {method};
  if (form) { init.body = new URLSearchParams(form).toString(); init.headers = {'Content-Type': 'application/x-www-form-urlencoded'}; }
  const r = await links(new Request(url, init), db);
  return {status: r.status, text: await r.text(), cookie: r.headers.get('Set-Cookie'), location: r.headers.get('Location')};
}
export const uuidOf = n => `${String(n).repeat(8).slice(0, 8)}-aaaa-4aaa-8aaa-${String(n).repeat(12).slice(0, 12)}`;
