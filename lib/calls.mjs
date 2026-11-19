// Open calls: grants, residencies, exhibitions and competitions with deadlines.
import {currentMember} from './auth.mjs';
import {appBase, callDeadlineEmail, callEmail} from './email.mjs';
import {allow} from './limits.mjs';
import {replyFor} from './notify.mjs';
import {enqueue, flush} from './outbox.mjs';

export const callKinds = ['Grant', 'Residency', 'Exhibition', 'Competition', 'Commission', 'Fellowship', 'Other'];
export const interestLabels = {interested: 'Interested', applying: 'Applying', applied: 'Applied'};
const HOUR = 3600000, DAY = 24 * HOUR;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const fail = (error, status = 400) => ({error, status});
const label = r => r.name || r.email.split('@')[0];
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function readCall(input, current = {}) {
  const pick = (key, length) => input[key] === undefined ? current[key] ?? '' : clean(input[key], length);
  const title = pick('title', 160);
  if (!title) return fail('Give the call a name.');
  const deadline = pick('deadline', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(deadline + 'T00:00:00Z'))) return fail('Choose the deadline.');
  const link = pick('link', 500);
  if (link && !/^https?:\/\/\S+$/i.test(link)) return fail('Links must start with http:// or https://');
  return {title, deadline, link, kind: callKinds.includes(input.kind) ? input.kind : current.kind ?? 'Other',
    organization: pick('organization', 160), award: pick('award', 160), details: pick('details', 5000)};
}

export async function setInterest(db, memberId, callId, status, now = Date.now()) {
  const call = await db.prepare('SELECT id FROM calls WHERE id=? AND hidden=false').bind(callId).first();
  if (!call) return fail('That call is gone.', 404);
  if (status === 'none') { await db.prepare('DELETE FROM call_interest WHERE call=? AND member=?').bind(callId, memberId).run(); return {ok: true}; }
  if (!interestLabels[status]) return fail('Choose interested, applying or applied.');
  await db.prepare(`INSERT INTO call_interest (call,member,status,updated) VALUES (?,?,?,?)
    ON CONFLICT (call,member) DO UPDATE SET status=excluded.status, updated=excluded.updated`).bind(callId, memberId, status, now).run();
  return {ok: true};
}

const view = (c, me) => ({id: c.id, title: c.title, kind: c.kind, organization: c.organization, deadline: c.deadline, link: c.link,
  award: c.award, details: c.details, hidden: c.hidden, author: c.name ? label(c) : '', mine: c.author === me.id, created: Number(c.created)});

export async function listCalls(db, me, now = Date.now()) {
  const rows = (await db.prepare(`SELECT c.*,m.name,m.email,i.status AS my_status,
      (SELECT COUNT(*)::integer FROM call_interest x WHERE x.call=c.id AND x.status IN ('applying','applied')) AS applying
    FROM calls c LEFT JOIN members m ON m.id=c.author LEFT JOIN call_interest i ON i.call=c.id AND i.member=?
    WHERE c.hidden=false OR ? ORDER BY c.deadline, c.created`).bind(me.id, me.role === 'organizer').all()).results;
  const list = rows.map(c => ({...view(c, me), myStatus: c.my_status ?? '', applying: c.applying}));
  return {open: list.filter(c => c.deadline >= today(now)), closed: list.filter(c => c.deadline < today(now)).reverse().slice(0, 30)};
}

// Members who want everything right away hear about a new call at once; others see it in their summary.
async function announce(db, mailer, base, call, author, now) {
  if (!mailer) return 0;
  const list = (await db.prepare(`SELECT id,email,name,token,'m:'||id AS voter FROM members
    WHERE status='active' AND emails='all' AND digest='instant' AND id<>?`).bind(author.id).all()).results;
  const messages = [];
  for (const sub of list) messages.push(callEmail({sub, base, call, author, replyTo: await replyFor(db, sub, 'call', call.id)}));
  return enqueue(db, '', messages, now);
}

// Daily: a week and a day before the deadline, to members who marked the call (once each).
export async function remindCalls(db, mailer, base, now = Date.now()) {
  if (!mailer || !base) return 0;
  const rows = (await db.prepare(`SELECT c.*,i.member,i.status,i.reminded,m.email,m.name,m.token FROM call_interest i
    JOIN calls c ON c.id=i.call JOIN members m ON m.id=i.member
    WHERE c.hidden=false AND i.status IN ('interested','applying') AND m.status='active' AND m.emails='all' AND c.deadline >= ?`).bind(today(now)).all()).results;
  let sent = 0;
  for (const r of rows) {
    const days = Math.round((Date.parse(r.deadline + 'T00:00:00Z') - Date.parse(today(now) + 'T00:00:00Z')) / DAY);
    const stage = days <= 1 ? 'day' : days <= 7 ? 'week' : '';
    const order = ['', 'week', 'day'];
    if (!stage || order.indexOf(stage) <= order.indexOf(r.reminded)) continue;
    const others = (await db.prepare(`SELECT m.name,m.email FROM call_interest i JOIN members m ON m.id=i.member
      WHERE i.call=? AND i.member<>? AND i.status IN ('applying','applied') AND m.status='active'`).bind(r.id, r.member).all()).results.map(label);
    const sub = {id: r.member, email: r.email, name: r.name, token: r.token};
    sent += await enqueue(db, '', [callDeadlineEmail({sub, base, call: r, stage, status: r.status, others, replyTo: await replyFor(db, sub, 'call', r.id)})], now);
    await db.prepare('UPDATE call_interest SET reminded=? WHERE call=? AND member=?').bind(stage, r.id, r.member).run();
  }
  return sent;
}

export async function calls(request, db, mailer = null, defer = null, now = Date.now()) {
  let queued = false;
  const response = await handle();
  if (queued && mailer && defer) defer(flush(db, mailer).catch(error => console.error('Outbox flush failed', error.code ?? error.name)));
  return response;

  async function handle() {
    const url = new URL(request.url), base = appBase(request), action = url.searchParams.get('action') || '';
    const run = (sql, ...args) => db.prepare(sql).bind(...args);
    const me = await currentMember(request, db, now);
    if (!me) return json({error: 'Sign in to see open calls.'}, 401);
    const organizer = me.role === 'organizer';
    const load = async id => uuid(id) ? run('SELECT c.*,m.name,m.email FROM calls c LEFT JOIN members m ON m.id=c.author WHERE c.id=?', id).first() : null;

    if (request.method === 'GET') {
      const id = url.searchParams.get('call');
      if (!id) return json({kinds: callKinds, ...await listCalls(db, me, now)});
      const c = await load(id);
      if (!c || (c.hidden && !organizer)) return json({error: 'Call not found.'}, 404);
      const people = (await run(`SELECT i.status,i.member,m.name,m.email FROM call_interest i JOIN members m ON m.id=i.member
        WHERE i.call=? AND m.status='active' ORDER BY i.updated`, c.id).all()).results;
      const comments = (await run(`SELECT k.id,k.body,k.via,k.created,k.author,m.name,m.email FROM comments k JOIN members m ON m.id=k.author
        WHERE k.kind='call' AND k.target=? AND k.hidden=false ORDER BY k.created`, c.id).all()).results
        .map(k => ({id: k.id, body: k.body, via: k.via, created: Number(k.created), author: label(k), mine: k.author === me.id}));
      return json({kinds: callKinds, me: {id: me.id, role: me.role}, call: {...view(c, me), canEdit: organizer || c.author === me.id,
        closed: c.deadline < today(now), myStatus: people.find(p => p.member === me.id)?.status ?? '',
        people: Object.fromEntries(Object.keys(interestLabels).map(s => [s, people.filter(p => p.status === s).map(label)])), comments}});
    }
    if (request.method !== 'POST') return json({error: 'Method unavailable.'}, 405);
    if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return json({error: 'Invalid request.'}, 403);
    const raw = await request.text();
    if (raw.length > 20000) return json({error: 'This is too long.'}, 413);
    let input;
    try { input = JSON.parse(raw) ?? {}; } catch { return json({error: 'Invalid entry.'}, 400); }

    if (action === 'create') {
      if (!await allow(db, 'call:' + me.id, 20, HOUR, now)) return json({error: 'Too many calls. Try again in an hour.'}, 429);
      const c = readCall(input);
      if (c.error) return json({error: c.error}, c.status);
      const id = crypto.randomUUID();
      await run('INSERT INTO calls (id,title,kind,organization,deadline,link,award,details,author,created) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, c.title, c.kind, c.organization, c.deadline, c.link, c.award, c.details, me.id, now).run();
      if (await announce(db, mailer, base, {id, ...c}, me, now)) queued = true;
      return json({ok: true, id}, 201);
    }
    if (action === 'interest') {
      if (!uuid(input.call)) return json({error: 'Choose a call.'}, 400);
      const r = await setInterest(db, me.id, input.call, input.status, now);
      return r.error ? json({error: r.error}, r.status) : json({ok: true});
    }
    const c = await load(input.call);
    if (!c) return json({error: 'Call not found.'}, 404);
    if (!(organizer || c.author === me.id)) return json({error: 'Only the person who shared this call, or an organizer, can change it.'}, 403);
    if (action === 'update') {
      const next = readCall(input, c);
      if (next.error) return json({error: next.error}, next.status);
      await run('UPDATE calls SET title=?,kind=?,organization=?,deadline=?,link=?,award=?,details=? WHERE id=?',
        next.title, next.kind, next.organization, next.deadline, next.link, next.award, next.details, c.id).run();
      if (next.deadline !== c.deadline) await run("UPDATE call_interest SET reminded='' WHERE call=?", c.id).run();
      return json({ok: true});
    }
    if (action === 'hide') {
      if (!organizer) return json({error: 'Only organizers can hide calls.'}, 403);
      await run('UPDATE calls SET hidden=? WHERE id=?', !!input.hidden, c.id).run();
      return json({ok: true});
    }
    if (action === 'delete') {
      await run("DELETE FROM comments WHERE kind='call' AND target=?", c.id).run();
      await run("DELETE FROM reply_keys WHERE kind='call' AND target=?", c.id).run();
      await run('DELETE FROM calls WHERE id=?', c.id).run();
      return json({ok: true});
    }
    return json({error: 'This action is unavailable.'}, 404);
  }
}
