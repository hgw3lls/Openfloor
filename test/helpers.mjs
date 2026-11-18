import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {wrap} from '../lib/db.mjs';
import {meetings} from '../lib/meetings.mjs';
import {links} from '../lib/links.mjs';

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

export function client(db, mailer, {cookie, ip = '203.0.113.1'} = {}) {
  const pending = [];
  const defer = promise => pending.push(promise);
  async function call(action, payload, {meeting = '', secret} = {}) {
    const headers = {Origin: ORIGIN, 'x-forwarded-for': ip};
    if (cookie) headers.Cookie = 'floor=' + cookie;
    if (secret) headers.Authorization = 'Bearer ' + secret;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const query = new URLSearchParams({meeting, action});
    const res = await meetings(new Request(ORIGIN + '/api/meeting?' + query, {method: payload === undefined ? 'GET' : 'POST', headers,
      body: payload === undefined ? undefined : JSON.stringify(payload)}), db, KEY, mailer, defer);
    await Promise.all(pending.splice(0));
    return {status: res.status, body: await res.json()};
  }
  return {call, get: meeting => call(undefined, undefined, meeting)};
}

export const link = (a, html) => html.match(new RegExp('href="([^"]*a=' + a + '[^"]*)"'))[1].replaceAll('&amp;', '&');
export async function visit(db, url, method = 'GET', cookie) {
  const headers = cookie ? {Cookie: 'floor=' + cookie} : {};
  const r = await links(new Request(url, {method, headers}), db);
  return {status: r.status, text: await r.text()};
}
export const uuid = n => `${String(n).repeat(8).slice(0, 8)}-aaaa-4aaa-8aaa-${String(n).repeat(12).slice(0, 12)}`;
