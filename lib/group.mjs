// The group: members, joining, signing in, and the dashboard of meetings.
import {timingSafeEqual} from 'node:crypto';
import {createSigninCode, currentMember, endSession, newToken, startSession} from './auth.mjs';
import {appBase, groupName, inviteEmail, joinRequestEmail, signinEmail} from './email.mjs';
import {allow, visitor} from './limits.mjs';
import {emailPattern} from './notify.mjs';
import {budgetLeft, enqueue, flush} from './outbox.mjs';
import {formatWhen} from './schedule.mjs';
import {decisions, listActions} from './follow.mjs';
import {randomBytes} from 'node:crypto';

const HOUR = 3600000, WEEK = 7 * 24 * HOUR;
const json = (data, status = 200, cookie) => {
  const response = Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
  if (cookie) response.headers.append('Set-Cookie', cookie);
  return response;
};
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const id = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
const sameSecret = (a, b) => { const x = Buffer.from(a ?? ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// "Ana Ruiz <ana@example.org>", "ana@example.org, Ana Ruiz", or just an email.
export function parseMembers(text) {
  const seen = new Set(), out = [];
  for (const line of text.split(/\r?\n|;/)) {
    const email = line.match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+\.[^\s<>(),;:"]{2,}/)?.[0]?.toLowerCase();
    if (!email || !emailPattern.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({email, name: line.replace(email, '').replace(/[<>(),;"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)});
  }
  return out;
}

async function meetingsFor(db, member, now) {
  const rows = (await db.prepare(`SELECT m.id,m.title,m.starts_at,m.timezone,m.duration,m.location,m.phase,m.schedule,m.created,
      r.status AS mine,
      (SELECT COUNT(*)::integer FROM rsvps x WHERE x.meeting=m.id AND x.status='yes') AS going
    FROM meetings m LEFT JOIN rsvps r ON r.meeting=m.id AND r.member=?
    WHERE m.created > 0 OR m.starts_at IS NOT NULL
    ORDER BY m.starts_at ASC NULLS LAST, m.created DESC`).bind(member.id).all()).results;
  const list = rows.map(m => {
    const start = m.starts_at ? new Date(m.starts_at) : null;
    return {id: m.id, title: m.title, phase: m.phase, location: m.location, mine: m.mine ?? '', going: m.going,
      startsAt: start?.toISOString() ?? null, when: start ? formatWhen(start, m.timezone) : m.schedule,
      past: !!start && start.getTime() + m.duration * 60000 < now};
  });
  return {upcoming: list.filter(m => !m.past), past: list.filter(m => m.past).reverse().slice(0, 20)};
}

export async function group(request, db, organizerKey, mailer = null, defer = null, now = Date.now()) {
  const url = new URL(request.url), base = appBase(request), action = url.searchParams.get('action') || '';
  const run = (sql, ...args) => db.prepare(sql).bind(...args);
  const who = visitor(request);
  let queued = false;
  const queue = async (meetingId, messages) => { if (!mailer || !messages.length) return 0; queued = true; return enqueue(db, meetingId, messages); };
  const response = await handle();
  if (queued && mailer && defer) defer(flush(db, mailer).catch(error => console.error('Outbox flush failed', error.code ?? error.name)));
  return response;

  async function handle() {
    const me = await currentMember(request, db, now);
    if (request.method === 'GET') {
      const organizers = (await run("SELECT COUNT(*)::integer AS n FROM members WHERE role='organizer' AND status='active'").first()).n;
      const data = {group: groupName(), emailEnabled: !!mailer, needsSetup: organizers === 0, me: null};
      if (!me) return json(data);
      data.me = {id: me.id, name: me.name, email: me.email, role: me.role, emails: me.emails, digest: me.digest};
      if (url.searchParams.get('view') === 'decisions') return json({...data, decisions: await decisions(db, now)});
      data.meetings = await meetingsFor(db, me, now);
      data.myActions = await listActions(db, "a.owner=? AND a.status='open'", me.id);
      data.feedUrl = me.feed ? base + '/api/calendar?feed=' + me.feed : '';
      if (me.role === 'organizer') {
        data.members = (await run("SELECT id,name,email,role,status,emails FROM members WHERE status<>'removed' ORDER BY status<>'requested', lower(name), email").all()).results;
      }
      return json(data);
    }
    if (request.method !== 'POST') return json({error: 'Method unavailable.'}, 405);
    if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) {
      return json({error: 'Invalid request.'}, 403);
    }
    const raw = await request.text();
    if (raw.length > 30000) return json({error: 'This entry is too long.'}, 413);
    let input;
    try { input = JSON.parse(raw) ?? {}; } catch { return json({error: 'Invalid entry.'}, 400); }
    if (input.website) return json({ok: true, notice: 'Thanks! Check your email.'}); // spam trap

    if (action === 'setup') {
      // The organizer key makes (or restores) an organizer and signs them in here.
      if (!await allow(db, 'setup:' + who, 10, HOUR, now)) return json({error: 'Too many tries. Wait an hour.'}, 429);
      if (!sameSecret(clean(input.organizerKey, 256), organizerKey)) return json({error: 'That organizer key is not right.'}, 403);
      const email = clean(input.email, 254).toLowerCase(), name = clean(input.name, 80);
      if (!emailPattern.test(email)) return json({error: 'Enter a valid email address.'}, 400);
      let member = await run('SELECT * FROM members WHERE email=?', email).first();
      if (member) await run("UPDATE members SET role='organizer', status='active', name=CASE WHEN ?<>'' THEN ? ELSE name END WHERE id=?", name, name, member.id).run();
      else {
        member = {id: crypto.randomUUID()};
        await run("INSERT INTO members (id,email,name,role,status,token,created) VALUES (?,?,?,'organizer','active',?,?)", member.id, email, name, newToken(), now).run();
      }
      return json({ok: true}, 200, await startSession(db, member.id, now));
    }

    if (action === 'signin') {
      const email = clean(input.email, 254).toLowerCase();
      if (!emailPattern.test(email)) return json({error: 'Enter a valid email address.'}, 400);
      if (!mailer) return json({error: 'Email is not set up yet, so sign-in links can’t be sent.'}, 409);
      if (!await allow(db, 'signin:' + who, 10, HOUR, now) || !await allow(db, 'signin:' + email, 5, HOUR, now)) {
        return json({error: 'Too many sign-in requests. Try again later.'}, 429);
      }
      const member = await run("SELECT * FROM members WHERE email=? AND status IN ('active','invited')", email).first();
      if (member) await queue('', [signinEmail({member, base, code: await createSigninCode(db, member.id, now)})]);
      return json({ok: true, notice: 'If that address is on the member list, a sign-in link is on its way.'});
    }

    if (action === 'join') {
      const email = clean(input.email, 254).toLowerCase(), name = clean(input.name, 80);
      if (!name) return json({error: 'Enter your name.'}, 400);
      if (!emailPattern.test(email)) return json({error: 'Enter a valid email address.'}, 400);
      if (!await allow(db, 'join:' + who, 5, HOUR, now)) return json({error: 'Too many requests. Try again later.'}, 429);
      const existing = await run('SELECT * FROM members WHERE email=?', email).first();
      const notice = 'Thanks! An organizer will review your request, and you’ll get an email when you’re in.';
      if (existing && ['active', 'invited'].includes(existing.status)) {
        if (existing.status === 'invited') await run("UPDATE members SET status='active' WHERE id=?", existing.id).run();
        if (mailer) await queue('', [signinEmail({member: existing, base, code: await createSigninCode(db, existing.id, now)})]);
        return json({ok: true, notice: 'You’re already a member. We’ve emailed you a sign-in link.'});
      }
      if (existing?.status === 'requested') return json({ok: true, notice});
      if (existing) await run("UPDATE members SET status='requested', name=? WHERE id=?", name, existing.id).run();
      else await run("INSERT INTO members (id,email,name,status,token,created) VALUES (?,?,?,'requested',?,?)", crypto.randomUUID(), email, name, newToken(), now).run();
      const organizers = (await run("SELECT email,token FROM members WHERE role='organizer' AND status='active'").all()).results;
      await queue('', organizers.map(organizer => joinRequestEmail({organizer, applicant: {name, email}, base})));
      return json({ok: true, notice});
    }

    if (!me) return json({error: 'Sign in first.'}, 401);

    if (action === 'signout') return json({ok: true}, 200, await endSession(request, db));
    if (action === 'feed') {
      // A private calendar link; asking again makes a new one and the old link stops working.
      const feed = randomBytes(20).toString('hex');
      await run('UPDATE members SET feed=? WHERE id=?', feed, me.id).run();
      return json({ok: true, feedUrl: base + '/api/calendar?feed=' + feed});
    }
    if (action === 'profile') {
      const name = clean(input.name, 80), emails = input.emails === 'none' ? 'none' : 'all';
      const digest = ['instant', 'daily', 'weekly'].includes(input.digest) ? input.digest : me.digest;
      await run('UPDATE members SET name=?, emails=?, digest=? WHERE id=?', name || me.name, emails, digest, me.id).run();
      return json({ok: true});
    }

    if (me.role !== 'organizer') return json({error: 'Only organizers can do that.'}, 403);

    if (action === 'add') {
      const people = parseMembers(clean(input.people, 20000)).slice(0, 200);
      if (!people.length) return json({error: 'Enter at least one email address.'}, 400);
      if (mailer && people.length > await budgetLeft(db, now)) return json({error: 'That’s more than today’s email limit allows. Add fewer people, or try again tomorrow.'}, 429);
      let invited = 0, already = 0;
      const messages = [];
      for (const p of people) {
        const existing = await run('SELECT * FROM members WHERE email=?', p.email).first();
        if (existing?.status === 'active') { already++; continue; }
        if (existing && existing.status === 'invited' && now - Number(existing.invited) < 24 * HOUR) { already++; continue; }
        let member = existing;
        if (member) {
          await run("UPDATE members SET status='invited', invited=?, name=CASE WHEN ?<>'' THEN ? ELSE name END WHERE id=?", now, p.name, p.name, member.id).run();
        } else {
          member = {id: crypto.randomUUID(), email: p.email, token: newToken()};
          await run("INSERT INTO members (id,email,name,status,token,created,invited) VALUES (?,?,?,'invited',?,?,?)", member.id, p.email, p.name, member.token, now, now).run();
        }
        messages.push(inviteEmail({member, base}));
        invited++;
      }
      await queue('', messages);
      return json({ok: true, notice: `Invited ${invited} ${invited === 1 ? 'person' : 'people'}` + (already ? `; ${already} already on the list or recently invited.` : '.') +
        (mailer ? '' : ' Email isn’t set up, so no invitations were sent.')});
    }

    if (!id(input.member)) return json({error: 'Choose a member.'}, 400);
    const target = await run('SELECT * FROM members WHERE id=?', input.member).first();
    if (!target) return json({error: 'That member was not found.'}, 404);
    const organizers = (await run("SELECT COUNT(*)::integer AS n FROM members WHERE role='organizer' AND status='active'").first()).n;
    const lastOrganizer = target.role === 'organizer' && target.status === 'active' && organizers <= 1;

    if (action === 'approve') {
      if (target.status !== 'requested') return json({error: 'That request was already handled.'}, 409);
      await run("UPDATE members SET status='active' WHERE id=?", target.id).run();
      await queue('', [signinEmail({member: target, base, welcome: true, code: await createSigninCode(db, target.id, now, WEEK)})]);
      return json({ok: true, notice: `${target.name || target.email} is in.`});
    }
    if (action === 'decline') {
      if (target.status !== 'requested') return json({error: 'That request was already handled.'}, 409);
      await run("UPDATE members SET status='removed' WHERE id=?", target.id).run();
      return json({ok: true, notice: 'Request declined.'});
    }
    if (action === 'remove') {
      if (lastOrganizer) return json({error: 'Add another organizer before removing the last one.'}, 409);
      await run("UPDATE members SET status='removed', role='member' WHERE id=?", target.id).run();
      await run('DELETE FROM sessions WHERE member=?', target.id).run();
      return json({ok: true, notice: `${target.name || target.email} was removed.`});
    }
    if (action === 'role') {
      const role = input.role === 'organizer' ? 'organizer' : 'member';
      if (role === 'member' && lastOrganizer) return json({error: 'The group needs at least one organizer.'}, 409);
      if (role === 'organizer' && target.status !== 'active') return json({error: 'Only active members can be organizers.'}, 409);
      await run('UPDATE members SET role=? WHERE id=?', role, target.id).run();
      return json({ok: true, notice: role === 'organizer' ? `${target.name || target.email} is now an organizer.` : `${target.name || target.email} is now a member.`});
    }
    return json({error: 'This action is unavailable.'}, 404);
  }
}
