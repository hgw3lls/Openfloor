// The group: members, joining, signing in, and the dashboard of meetings.
import {timingSafeEqual} from 'node:crypto';
import {burnShortCodes, createShortCode, createSigninCode, currentMember, useShortCode, endSession, newToken, startSession} from './auth.mjs';
import {appBase, groupName, inviteEmail, joinRequestEmail, organizerEmail, signinEmail} from './email.mjs';
import {allow, visitor} from './limits.mjs';
import {emailPattern} from './notify.mjs';
import {budgetLeft, enqueue, flush} from './outbox.mjs';
import {formatWhen} from './schedule.mjs';
import {decisions, listActions} from './follow.mjs';
import {listEvents, mySlots} from './events.mjs';
import {listCalls} from './calls.mjs';
import {wallData} from './wall.mjs';
import {featureList, getFeatures, levelFor, setFeatures} from './features.mjs';
import {randomBytes} from 'node:crypto';
import {welcome} from './welcome.mjs';
import {adminBranding, getBranding, logoResponse, publicBranding, setBranding} from './brand.mjs';

const HOUR = 3600000, WEEK = 7 * 24 * HOUR;
// "In today": a studio check-in lasts 12 hours, or until you tap again.
const IN_FOR = 12 * HOUR;
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
      (SELECT COUNT(*)::integer FROM rsvps x WHERE x.meeting=m.id AND x.status='yes') AS going,
      (SELECT COUNT(*)::integer FROM topics t WHERE t.meeting=m.id AND t.hidden=false) AS topics
    FROM meetings m LEFT JOIN rsvps r ON r.meeting=m.id AND r.member=?
    WHERE m.created > 0 OR m.starts_at IS NOT NULL
    ORDER BY m.starts_at ASC NULLS LAST, m.created DESC`).bind(member.id).all()).results;
  const list = rows.map(m => {
    const start = m.starts_at ? new Date(m.starts_at) : null;
    return {id: m.id, title: m.title, phase: m.phase, location: m.location, mine: m.mine ?? '', going: m.going, topics: m.topics, timezone: m.timezone, duration: m.duration,
      startsAt: start?.toISOString() ?? null, when: start ? formatWhen(start, m.timezone) : m.schedule,
      past: !!start && start.getTime() + m.duration * 60000 < now};
  });
  return {upcoming: list.filter(m => !m.past), past: list.filter(m => m.past).reverse().slice(0, 20)};
}

// The organizer panel's overview: what needs attention.
async function overview(db, now) {
  const one = async (sql, ...args) => (await db.prepare(sql).bind(...args).first());
  const DAY = 86400000;
  const members = await one(`SELECT COUNT(*) FILTER (WHERE status='active')::integer AS active, COUNT(*) FILTER (WHERE status='invited')::integer AS invited,
    COUNT(*) FILTER (WHERE status='requested')::integer AS requested, COUNT(*) FILTER (WHERE status='active' AND emails='none')::integer AS no_email FROM members`);
  const meetings = (await db.prepare(`SELECT m.id,m.title,m.starts_at,m.timezone,m.phase,
      (SELECT COUNT(*)::integer FROM rsvps r JOIN members x ON x.id=r.member WHERE r.meeting=m.id AND r.status='yes' AND x.status='active') AS going,
      (SELECT COUNT(*)::integer FROM rsvps r JOIN members x ON x.id=r.member WHERE r.meeting=m.id AND r.status='maybe' AND x.status='active') AS maybe,
      (SELECT COUNT(*)::integer FROM rsvps r JOIN members x ON x.id=r.member WHERE r.meeting=m.id AND r.status='no' AND x.status='active') AS declined,
      (SELECT COUNT(*)::integer FROM topics t WHERE t.meeting=m.id AND t.hidden=false) AS topics
    FROM meetings m WHERE m.starts_at IS NULL OR m.starts_at + make_interval(mins => m.duration) > ? ORDER BY m.starts_at NULLS LAST LIMIT 10`).bind(new Date(now).toISOString()).all()).results
    .map(m => ({id: m.id, title: m.title, phase: m.phase, topics: m.topics, going: m.going, maybe: m.maybe, declined: m.declined,
      noAnswer: Math.max(0, members.active - m.going - m.maybe - m.declined), when: m.starts_at ? formatWhen(new Date(m.starts_at), m.timezone) : 'Date to be set'}));
  const today = new Date(now).toISOString().slice(0, 10);
  const actions = await one(`SELECT COUNT(*) FILTER (WHERE status='open')::integer AS open, COUNT(*) FILTER (WHERE status='open' AND due<>'' AND due < ?)::integer AS overdue,
    COUNT(*) FILTER (WHERE status='open' AND owner IS NULL)::integer AS unowned FROM actions`, today);
  const email = await one(`SELECT COUNT(*) FILTER (WHERE status IN ('queued','sending'))::integer AS waiting, COUNT(*) FILTER (WHERE status='failed')::integer AS retrying,
    COUNT(*) FILTER (WHERE status='dead')::integer AS failed, COUNT(*) FILTER (WHERE status='sent' AND updated > ?)::integer AS sent_today FROM outbox`, now - DAY);
  const polled = await one("SELECT value FROM settings WHERE key='inbox_polled'");
  return {members, meetings, actions, email: {...email, limit: Number.parseInt(process.env.EMAIL_DAILY_LIMIT, 10) || 400,
    repliesCheckedAt: polled ? Number(polled.value) : null}};
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
    // The uploaded logo images are public: they appear in emails and on the sign-in page.
    if (request.method === 'GET' && url.searchParams.has('logo')) return logoResponse(db, url.searchParams.get('logo'));
    const me = await currentMember(request, db, now);
    if (request.method === 'GET') {
      const organizers = (await run("SELECT COUNT(*)::integer AS n FROM members WHERE role='organizer' AND status='active'").first()).n;
      const branding = await getBranding(db);
      const data = {group: groupName(), emailEnabled: !!mailer, needsSetup: organizers === 0, me: null, branding: publicBranding(branding)};
      if (!me) return json(data);
      data.me = {id: me.id, name: me.name, email: me.email, role: me.role, emails: me.emails, digest: me.digest, medium: me.medium ?? '', title: me.title ?? '', since: Number(me.created),
        notify: {meetings: me.notify_meetings !== false, proposals: me.notify_proposals !== false, calls: me.notify_calls !== false, signups: me.notify_signups !== false}};
      // What members get; the site uses it for member preview too. Organizers always have everything.
      data.features = await getFeatures(db);
      const level = key => levelFor(data.features, me.role, key);
      if (url.searchParams.get('view') === 'decisions') return json({...data, decisions: await decisions(db, now)});
      if (url.searchParams.get('view') === 'directory') {
        // Who's in the group, for every member: names and roles only, never email addresses.
        const people = (await run(`SELECT m.id,m.name,m.email,m.role,m.medium,m.title,m.created,(c.at > ?) AS in_today FROM members m LEFT JOIN checkins c ON c.member=m.id
          WHERE m.status='active' ORDER BY lower(COALESCE(NULLIF(m.name,''),m.email))`, now - IN_FOR).all()).results;
        return json({...data, directory: people.map(m => ({id: m.id, name: m.name || m.email.split('@')[0], role: m.role, medium: m.medium, title: m.title, since: Number(m.created), me: m.id === me.id, inToday: !!m.in_today}))});
      }
      data.meetings = await meetingsFor(db, me, now);
      data.myActions = await listActions(db, "a.owner=? AND a.status='open'", me.id);
      data.inToday = (await run(`SELECT m.id,m.name,m.email FROM checkins c JOIN members m ON m.id=c.member WHERE c.at > ? AND m.status='active' ORDER BY c.at`, now - IN_FOR).all()).results
        .map(m => ({name: m.name || m.email.split('@')[0], me: m.id === me.id}));
      data.feedUrl = me.feed ? base + '/api/calendar?feed=' + me.feed : '';
      const ev = level('events') === 'off' ? {upcoming: []} : await listEvents(db, me, now);
      data.upcomingEvents = ev.upcoming.filter(e => !e.hidden);
      data.comingUp = data.upcomingEvents.slice(0, 5);
      data.helpWanted = level('signups') === 'off' ? [] : ev.upcoming.filter(e => !e.hidden && e.taken < e.spots).slice(0, 5);
      data.mySlots = level('signups') === 'off' || level('events') === 'off' ? [] : await mySlots(db, me.id, now);
      const openCalls = level('calls') === 'off' ? [] : (await listCalls(db, me, now)).open.filter(c => !c.hidden);
      data.deadlines = [...openCalls.filter(c => c.myStatus && c.myStatus !== 'applied'), ...openCalls.filter(c => !c.myStatus)].slice(0, 4);
      data.openCalls = openCalls;
      Object.assign(data, await wallData(db, me, level, now));
      if (me.role === 'organizer' && url.searchParams.get('view') === 'organize') data.overview = await overview(db, now);
      if (me.role === 'organizer') {
        data.featureList = featureList;
        data.brandingAdmin = adminBranding(branding);
        data.members = (await run("SELECT id,name,email,role,status,emails,title FROM members WHERE status<>'removed' ORDER BY status<>'requested', lower(name), email").all()).results;
      }
      return json(data);
    }
    if (request.method !== 'POST') return json({error: 'Method unavailable.'}, 405);
    if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) {
      return json({error: 'Invalid request.'}, 403);
    }
    const raw = await request.text();
    // Logo uploads are images (up to 500 KB, sent as base64); everything else is short.
    if (raw.length > (action === 'branding' ? 720000 : 30000)) return json({error: action === 'branding' ? 'That image is too big. Keep it under 500 KB.' : 'This entry is too long.'}, 413);
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
      if (member) await queue('', [signinEmail({member, base, code: await createSigninCode(db, member.id, now), short: await createShortCode(db, member.id, now)})]);
      return json({ok: true, notice: 'If that address is on the member list, a sign-in link is on its way.'});
    }

    if (action === 'code') {
      const email = clean(input.email, 254).toLowerCase();
      if (!await allow(db, 'code:' + who, 20, HOUR, now) || !await allow(db, 'code:' + email, 5, HOUR, now)) {
        await burnShortCodes(db, email);
        return json({error: 'Too many tries. Ask for a new code in an hour.'}, 429);
      }
      const member = await useShortCode(db, email, clean(input.code, 12).replace(/\s/g, ''), now);
      if (!member) {
        if (!await allow(db, 'codefail:' + email, 4, 30 * 60000, now)) await burnShortCodes(db, email);
        return json({error: 'That code isn’t right or has expired. Codes work once, for 30 minutes.'}, 400);
      }
      if (member.status === 'invited') {
        await run("UPDATE members SET status='active' WHERE id=?", member.id).run();
        if (mailer && await welcome(db, member, base, {now})) queued = true;
      }
      return json({ok: true}, 200, await startSession(db, member.id, now));
    }

    if (action === 'join') {
      const email = clean(input.email, 254).toLowerCase(), name = clean(input.name, 80);
      if (!name) return json({error: 'Enter your name.'}, 400);
      if (!emailPattern.test(email)) return json({error: 'Enter a valid email address.'}, 400);
      if (!await allow(db, 'join:' + who, 5, HOUR, now)) return json({error: 'Too many requests. Try again later.'}, 429);
      const existing = await run('SELECT * FROM members WHERE email=?', email).first();
      // The same reply whoever asks, so the form can't be used to find out
      // whether an address is on the member list.
      const notice = 'Thanks! Check your email. If you’re already a member, a sign-in link is on its way. If not, an organizer will review your request and you’ll get an email when you’re in.';
      if (existing && ['active', 'invited'].includes(existing.status)) {
        // Only the email link proves the address, so nothing changes here:
        // an invited member stays invited until they use their link.
        if (!await allow(db, 'signin:' + email, 5, HOUR, now)) return json({ok: true, notice});
        if (mailer) await queue('', [signinEmail({member: existing, base, code: await createSigninCode(db, existing.id, now), short: await createShortCode(db, existing.id, now)})]);
        return json({ok: true, notice});
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
    if (action === 'checkin') {
      if (input.in) await run('INSERT INTO checkins (member,at) VALUES (?,?) ON CONFLICT (member) DO UPDATE SET at=excluded.at', me.id, now).run();
      else await run('DELETE FROM checkins WHERE member=?', me.id).run();
      return json({ok: true});
    }
    if (action === 'profile') {
      const name = clean(input.name, 80), emails = input.emails === 'none' ? 'none' : 'all';
      const digest = ['instant', 'daily', 'weekly'].includes(input.digest) ? input.digest : me.digest;
      const medium = input.medium === undefined ? me.medium ?? '' : clean(input.medium, 80);
      await run('UPDATE members SET name=?, emails=?, digest=?, medium=? WHERE id=?', name || me.name, emails, digest, medium, me.id).run();
      // Which kinds of email you want (each switch is on unless sent as false).
      if (input.notify && typeof input.notify === 'object') {
        const n = key => input.notify[key] === undefined ? me['notify_' + key] !== false : !!input.notify[key];
        await run('UPDATE members SET notify_meetings=?, notify_proposals=?, notify_calls=?, notify_signups=? WHERE id=?', n('meetings'), n('proposals'), n('calls'), n('signups'), me.id).run();
      }
      return json({ok: true});
    }

    if (me.role !== 'organizer') return json({error: 'Only organizers can do that.'}, 403);

    if (action === 'features') return json({ok: true, features: await setFeatures(db, input)});
    if (action === 'branding') {
      const result = await setBranding(db, input, now);
      return result.error ? json({error: result.error}, 400) : json(result);
    }

    if (action === 'add') {
      const people = parseMembers(clean(input.people, 20000)).slice(0, 200);
      if (!people.length) return json({error: 'Enter at least one email address.'}, 400);
      if (mailer && people.length > await budgetLeft(db, now)) return json({error: 'That’s more than today’s email limit allows. Add fewer people, or try again tomorrow.'}, 429);
      // "Make them organizers": new people get the role when they accept; members are promoted now.
      const asOrganizer = input.role === 'organizer', role = asOrganizer ? 'organizer' : 'member';
      let invited = 0, already = 0, promoted = 0;
      const messages = [];
      for (const p of people) {
        const existing = await run('SELECT * FROM members WHERE email=?', p.email).first();
        if (existing?.status === 'active') {
          if (asOrganizer && existing.role !== 'organizer') {
            await run("UPDATE members SET role='organizer' WHERE id=?", existing.id).run();
            messages.push(organizerEmail({member: existing, base, by: me.name || me.email}));
            promoted++;
          } else already++;
          continue;
        }
        if (existing && existing.status === 'invited' && now - Number(existing.invited) < 24 * HOUR) { already++; continue; }
        let member = existing;
        if (member) {
          await run("UPDATE members SET status='invited', invited=?, role=?, name=CASE WHEN ?<>'' THEN ? ELSE name END WHERE id=?", now, role, p.name, p.name, member.id).run();
        } else {
          member = {id: crypto.randomUUID(), email: p.email, token: newToken()};
          await run("INSERT INTO members (id,email,name,role,status,token,created,invited) VALUES (?,?,?,?,'invited',?,?,?)", member.id, p.email, p.name, role, member.token, now, now).run();
        }
        messages.push(inviteEmail({member, base, organizer: asOrganizer}));
        invited++;
      }
      await queue('', messages);
      return json({ok: true, notice: `Invited ${invited} ${invited === 1 ? 'person' : 'people'}${asOrganizer ? ' as organizers' : ''}` + (promoted ? `; made ${promoted} existing ${promoted === 1 ? 'member an organizer' : 'members organizers'}` : '') + (already ? `; ${already} already on the list or recently invited.` : '.') +
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
      if (mailer) {
        const code = await createSigninCode(db, target.id, now, WEEK);
        // New members get the welcome guide with their sign-in link; anyone
        // welcomed before (e.g. rejoining) just gets the sign-in email.
        const signin = base + '/api/email?' + new URLSearchParams({a: 'signin', c: code});
        if (await welcome(db, target, base, {signin, now})) queued = true;
        else await queue('', [signinEmail({member: target, base, welcome: true, code})]);
      }
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
      // Free their volunteer places, drop them from "going", "in today" and open
      // calls, and take back their votes on proposals still being decided.
      for (const table of ['claims', 'going', 'checkins', 'call_interest', 'call_checks']) await run(`DELETE FROM ${table} WHERE member=?`, target.id).run();
      await run("DELETE FROM proposal_votes WHERE member=? AND proposal IN (SELECT id FROM proposals WHERE status='open')", target.id).run();
      return json({ok: true, notice: `${target.name || target.email} was removed.`});
    }
    if (action === 'title') {
      // A role label shown to everyone, like Committee or Treasurer (separate from organizer access).
      await run('UPDATE members SET title=? WHERE id=?', clean(input.title, 40), target.id).run();
      return json({ok: true});
    }
    if (action === 'role') {
      const role = input.role === 'organizer' ? 'organizer' : 'member';
      if (role === 'member' && lastOrganizer) return json({error: 'The group needs at least one organizer.'}, 409);
      if (role === 'organizer' && target.status !== 'active') return json({error: 'Only active members can be organizers.'}, 409);
      if (role === target.role) return json({ok: true, notice: 'No change.'});
      await run('UPDATE members SET role=? WHERE id=?', role, target.id).run();
      if (role === 'organizer') await queue('', [organizerEmail({member: target, base, by: me.name || me.email})]);
      return json({ok: true, notice: role === 'organizer' ? `${target.name || target.email} is now an organizer.` : `${target.name || target.email} is now a member.`});
    }
    return json({error: 'This action is unavailable.'}, 404);
  }
}
