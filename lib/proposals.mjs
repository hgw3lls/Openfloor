// Proposals: any member drafts one, another member seconds it, then everyone
// votes For / Against / Abstain until it closes. It counts if more than half of
// active members voted (abstaining counts); it carries if For beats Against.
// Votes are open: members see who voted which way.
import {currentMember} from './auth.mjs';
import {appBase, proposalEmail, proposalReminderEmail} from './email.mjs';
import {allow} from './limits.mjs';
import {audience, blocked, check, getFeatures, levelFor} from './features.mjs';
import {recipients, replyFor, notify} from './notify.mjs';
import {enqueue, flush} from './outbox.mjs';

export const proposalKinds = ['Money', 'Studio', 'Shows', 'Members', 'Other'];
export const voteLabels = {for: 'For', against: 'Against', abstain: 'Abstain'};
const HOUR = 3600000, DAY = 24 * HOUR;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const fail = (error, status = 400) => ({error, status});
const label = r => r.name || r.email.split('@')[0];
export const quorumOf = eligible => Math.floor(eligible / 2) + 1;
const activeCount = async db => (await db.prepare("SELECT COUNT(*)::integer AS n FROM members WHERE status='active'").bind().first()).n;

function readProposal(input, current = {}) {
  const pick = (key, length) => input[key] === undefined ? current[key] ?? '' : clean(input[key], length);
  const title = pick('title', 140);
  if (!title) return fail('Give the proposal a title.');
  const days = input.days === undefined ? current.days ?? 7 : Number.parseInt(input.days, 10);
  if (!(days >= 1 && days <= 30)) return fail('Voting can stay open for 1 to 30 days.');
  return {title, days, kind: proposalKinds.includes(input.kind) ? input.kind : current.kind ?? 'Other',
    figure: pick('figure', 40), summary: pick('summary', 2000), reason: pick('reason', 1000), effect: pick('effect', 500)};
}

// Close every open proposal whose time is up, recording the result.
export async function closeDue(db, now = Date.now()) {
  const due = (await db.prepare("SELECT id FROM proposals WHERE status='open' AND closes_at <= ?").bind(now).all()).results;
  if (!due.length) return 0;
  const eligible = await activeCount(db);
  for (const {id} of due) {
    const t = await tally(db, id);
    const voted = t.for + t.against + t.abstain;
    const status = voted < quorumOf(eligible) ? 'no_quorum' : t.for > t.against ? 'carried' : 'not_carried';
    await db.prepare("UPDATE proposals SET status=?, closed_at=?, for_n=?, against_n=?, abstain_n=?, eligible=? WHERE id=? AND status='open'")
      .bind(status, now, t.for, t.against, t.abstain, eligible, id).run();
  }
  return due.length;
}

async function tally(db, id) {
  const rows = (await db.prepare(`SELECT v.vote, COUNT(*)::integer AS n FROM proposal_votes v JOIN members m ON m.id=v.member
    WHERE v.proposal=? AND m.status='active' GROUP BY v.vote`).bind(id).all()).results;
  const t = {for: 0, against: 0, abstain: 0};
  for (const r of rows) t[r.vote] = r.n;
  return t;
}

export async function castProposalVote(db, memberId, id, vote, now = Date.now()) {
  const denied = await check(db, memberId, 'proposals');
  if (denied) return denied;
  await closeDue(db, now);
  const p = await db.prepare('SELECT id,status FROM proposals WHERE id=?').bind(id).first();
  if (!p) return fail('That proposal is gone.', 404);
  if (p.status !== 'open') return fail(p.status === 'draft' ? 'Voting opens once the proposal is seconded.' : 'Voting on this proposal has closed.', 409);
  if (vote === 'none') { await db.prepare('DELETE FROM proposal_votes WHERE proposal=? AND member=?').bind(id, memberId).run(); return {ok: true}; }
  if (!voteLabels[vote]) return fail('Choose For, Against or Abstain.');
  await db.prepare(`INSERT INTO proposal_votes (proposal,member,vote,updated) VALUES (?,?,?,?)
    ON CONFLICT (proposal,member) DO UPDATE SET vote=excluded.vote, updated=excluded.updated`).bind(id, memberId, vote, now).run();
  return {ok: true};
}

const summaryOf = (p, t, eligible) => {
  const counts = p.status === 'open' || p.status === 'draft' ? t : {for: p.for_n, against: p.against_n, abstain: p.abstain_n};
  const elig = p.status === 'open' || p.status === 'draft' ? eligible : p.eligible;
  const voted = counts.for + counts.against + counts.abstain;
  return {counts, eligible: elig, quorum: quorumOf(elig), voted, quorumMet: voted >= quorumOf(elig)};
};
const view = (p, me, extra = {}) => ({id: p.id, number: p.number, title: p.title, kind: p.kind, figure: p.figure, summary: p.summary, reason: p.reason, effect: p.effect,
  days: p.days, status: p.status, created: Number(p.created), opened: p.opened ? Number(p.opened) : null, closesAt: p.closes_at ? Number(p.closes_at) : null,
  closedAt: p.closed_at ? Number(p.closed_at) : null, author: p.author_name || p.author_email ? label({name: p.author_name, email: p.author_email || ''}) : '',
  seconder: p.seconder_name || p.seconder_email ? label({name: p.seconder_name, email: p.seconder_email || ''}) : '', mine: p.author === me.id, ...extra});
const SELECT = `SELECT p.*,a.name AS author_name,a.email AS author_email,s.name AS seconder_name,s.email AS seconder_email FROM proposals p
  LEFT JOIN members a ON a.id=p.author LEFT JOIN members s ON s.id=p.seconder`;

export async function listProposals(db, me, now = Date.now()) {
  await closeDue(db, now);
  const eligible = await activeCount(db);
  const rows = (await db.prepare(SELECT + " WHERE p.status<>'withdrawn' ORDER BY p.number DESC").bind().all()).results;
  const mine = Object.fromEntries((await db.prepare('SELECT proposal,vote FROM proposal_votes WHERE member=?').bind(me.id).all()).results.map(r => [r.proposal, r.vote]));
  const out = [];
  for (const p of rows) out.push(view(p, me, {...summaryOf(p, p.status === 'open' ? await tally(db, p.id) : {for: 0, against: 0, abstain: 0}, eligible), myVote: mine[p.id] ?? ''}));
  return {open: out.filter(p => p.status === 'open'), drafts: out.filter(p => p.status === 'draft'), closed: out.filter(p => !['open', 'draft'].includes(p.status))};
}

// Daily: a reminder a day before closing to members who haven't voted.
export async function remindProposals(db, mailer, base, now = Date.now()) {
  if (!mailer || !base) return 0;
  const due = (await db.prepare("SELECT * FROM proposals WHERE status='open' AND reminded=false AND closes_at > ? AND closes_at <= ?").bind(now, now + 30 * HOUR).all()).results;
  let sent = 0;
  for (const p of due) {
    const list = await recipients(db, `AND m.notify_proposals AND NOT EXISTS (SELECT 1 FROM proposal_votes v WHERE v.proposal=? AND v.member=m.id) ${await audience(db, 'proposals')}`, p.id);
    sent += await notify(db, mailer, null, async sub => proposalReminderEmail({sub, base, proposal: p, replyTo: await replyFor(db, sub, 'proposal', p.id)}), list);
    await db.prepare('UPDATE proposals SET reminded=true WHERE id=?').bind(p.id).run();
  }
  return sent;
}

export async function proposals(request, db, mailer = null, defer = null, now = Date.now()) {
  let queued = false;
  const response = await handle();
  if (queued && mailer && defer) defer(flush(db, mailer).catch(error => console.error('Outbox flush failed', error.code ?? error.name)));
  return response;

  async function handle() {
    const url = new URL(request.url), base = appBase(request), action = url.searchParams.get('action') || '';
    const run = (sql, ...args) => db.prepare(sql).bind(...args);
    const me = await currentMember(request, db, now);
    if (!me) return json({error: 'Sign in to see proposals.'}, 401);
    const organizer = me.role === 'organizer';
    const features = await getFeatures(db), level = levelFor(features, me.role, 'proposals');
    if (level === 'off') return json(blocked(features, 'proposals'), 403);
    await closeDue(db, now);
    const load = async id => uuid(id) ? run(SELECT + ' WHERE p.id=?', id).first() : null;

    if (request.method === 'GET') {
      const id = url.searchParams.get('proposal');
      if (!id) return json({kinds: proposalKinds, ...await listProposals(db, me, now)});
      const p = await load(id);
      if (!p || p.status === 'withdrawn') return json({error: 'Proposal not found.'}, 404);
      const eligible = await activeCount(db);
      const votes = (await run(`SELECT v.vote,v.member,m.name,m.email FROM proposal_votes v JOIN members m ON m.id=v.member
        WHERE v.proposal=? AND m.status='active' ORDER BY v.updated`, p.id).all()).results;
      const notVoted = p.status === 'open' ? (await run(`SELECT name,email FROM members m WHERE status='active'
        AND NOT EXISTS (SELECT 1 FROM proposal_votes v WHERE v.proposal=? AND v.member=m.id) ORDER BY lower(COALESCE(NULLIF(name,''),email))`, p.id).all()).results.map(label) : [];
      const comments = (await run(`SELECT k.id,k.body,k.via,k.created,k.author,m.name,m.email FROM comments k JOIN members m ON m.id=k.author
        WHERE k.kind='proposal' AND k.target=? AND k.hidden=false ORDER BY k.created`, p.id).all()).results
        .map(k => ({id: k.id, body: k.body, via: k.via, created: Number(k.created), author: label(k), mine: k.author === me.id}))
        .filter(() => levelFor(features, me.role, 'comments') !== 'off');
      const t = {for: 0, against: 0, abstain: 0};
      for (const v of votes) t[v.vote]++;
      return json({kinds: proposalKinds, proposal: {...view(p, me, summaryOf(p, t, eligible)), myVote: votes.find(v => v.member === me.id)?.vote ?? '',
        voters: votes.map(v => ({name: label(v), vote: v.vote})), notVoted, comments,
        canSecond: p.status === 'draft' && p.author !== me.id && level === 'full', canEdit: (organizer || p.author === me.id) && p.status === 'draft',
        canWithdraw: (organizer || p.author === me.id) && ['draft', 'open'].includes(p.status), canDelete: organizer}});
    }
    if (request.method !== 'POST') return json({error: 'Method unavailable.'}, 405);
    if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return json({error: 'Invalid request.'}, 403);
    const raw = await request.text();
    if (raw.length > 20000) return json({error: 'This is too long.'}, 413);
    let input;
    try { input = JSON.parse(raw) ?? {}; } catch { return json({error: 'Invalid entry.'}, 400); }

    if (action === 'vote') {
      if (!uuid(input.proposal)) return json({error: 'Choose a proposal.'}, 400);
      const r = await castProposalVote(db, me.id, input.proposal, input.vote, now);
      return r.error ? json({error: r.error}, r.status) : json({ok: true});
    }
    if (level !== 'full' && !organizer) return json(blocked(features, 'proposals'), 403);
    if (action === 'create') {
      if (!await allow(db, 'proposal:' + me.id, 10, DAY, now)) return json({error: 'That’s a lot of proposals for one day. Try again tomorrow.'}, 429);
      const c = readProposal(input);
      if (c.error) return json({error: c.error}, c.status);
      const id = crypto.randomUUID();
      // One counter row, bumped in a single statement, so two proposals made
      // at the same moment can't get the same number.
      const number = Number((await run(`INSERT INTO settings (key,value) VALUES ('proposal_number', (SELECT COALESCE(MAX(number),0)+1 FROM proposals)::text)
        ON CONFLICT (key) DO UPDATE SET value=(GREATEST(settings.value::integer, (SELECT COALESCE(MAX(number),0) FROM proposals))+1)::text RETURNING value`).first()).value);
      await run('INSERT INTO proposals (id,number,title,kind,figure,summary,reason,effect,days,author,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, number, c.title, c.kind, c.figure, c.summary, c.reason, c.effect, c.days, me.id, now).run();
      return json({ok: true, id, number}, 201);
    }
    const p = await load(input.proposal);
    if (!p || p.status === 'withdrawn') return json({error: 'Proposal not found.'}, 404);
    if (action === 'second') {
      if (p.status !== 'draft') return json({error: 'This proposal is already open for voting.'}, 409);
      if (p.author === me.id) return json({error: 'Someone else needs to second your proposal.'}, 403);
      const opened = await run("UPDATE proposals SET status='open', seconder=?, opened=?, closes_at=? WHERE id=? AND status='draft'", me.id, now, now + p.days * DAY, p.id).run();
      if (!opened.meta.changes) return json({error: 'This proposal is already open for voting.'}, 409);
      if (mailer) {
        const fresh = await load(p.id);
        const list = await recipients(db, 'AND m.notify_proposals' + await audience(db, 'proposals'));
        if (await notify(db, mailer, null, async sub => proposalEmail({sub, base, proposal: fresh, replyTo: await replyFor(db, sub, 'proposal', p.id)}), list)) queued = true;
      }
      return json({ok: true});
    }
    if (!(organizer || p.author === me.id)) return json({error: 'Only the person who proposed this, or an organizer, can change it.'}, 403);
    if (action === 'update') {
      if (p.status !== 'draft') return json({error: 'A proposal can’t be changed once voting has opened.'}, 409);
      const next = readProposal(input, p);
      if (next.error) return json({error: next.error}, next.status);
      await run('UPDATE proposals SET title=?,kind=?,figure=?,summary=?,reason=?,effect=?,days=? WHERE id=?', next.title, next.kind, next.figure, next.summary, next.reason, next.effect, next.days, p.id).run();
      return json({ok: true});
    }
    if (action === 'withdraw') {
      if (!['draft', 'open'].includes(p.status)) return json({error: 'Voting on this proposal has closed.'}, 409);
      await run("UPDATE proposals SET status='withdrawn', closed_at=? WHERE id=?", now, p.id).run();
      return json({ok: true});
    }
    if (action === 'delete') {
      if (!organizer) return json({error: 'Only organizers can delete a proposal.'}, 403);
      await run("DELETE FROM comments WHERE kind='proposal' AND target=?", p.id).run();
      await run("DELETE FROM reply_keys WHERE kind='proposal' AND target=?", p.id).run();
      await run('DELETE FROM proposals WHERE id=?', p.id).run();
      return json({ok: true});
    }
    return json({error: 'This action is unavailable.'}, 404);
  }
}
