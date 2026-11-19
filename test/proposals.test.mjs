import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, fakeMailer, client, member, link, visit, ORIGIN} from './helpers.mjs';
import {flush} from '../lib/outbox.mjs';
import {remindProposals, closeDue} from '../lib/proposals.mjs';
import {emailActions} from '../lib/actions.mjs';
import {processMessage} from '../lib/replies.mjs';

process.env.SMTP_USER = 'towerpress@gmail.com';
process.env.SMTP_PASS = 'test';
const DAY = 86400000;
const PASS = 'mx.google.com; dkim=pass header.i=@example.org; dmarc=pass header.from=example.org';
let n = 0;
const raw = (from, to, body) => `From: ${from}\r\nTo: ${to}\r\nSubject: Re\r\nAuthentication-Results: ${PASS}\r\nMessage-ID: <pr-${++n}@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

async function world() {
  const {db, pg} = await setup();
  const mailer = fakeMailer();
  const o = await member(db, 'org@example.org', {role: 'organizer', name: 'Olu'});
  const a = await member(db, 'ana@example.org', {name: 'Ana'});
  const b = await member(db, 'ben@example.org', {name: 'Ben'});
  const c = await member(db, 'cy@example.org', {name: 'Cy'});
  const cl = m => client(db, mailer, {session: m.session});
  return {db, pg, mailer, o, a, b, c, org: cl(o), ana: cl(a), ben: cl(b), cy: cl(c), guest: client(db, mailer)};
}
async function propose(w, extra = {}) {
  const r = await w.ana.proposals('create', {title: 'Shared press maintenance fund', kind: 'Money', figure: '£5 a month each', summary: 'So the Columbian is serviced every year.',
    reason: 'A small monthly pot means we never scramble for it.', effect: 'Starts January.', days: 7, ...extra});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
const close = async (w, id) => { await w.pg.query('UPDATE proposals SET closes_at=$1 WHERE id=$2', [Date.now() - 1000, id]); return (await w.org.proposals('', undefined, {proposal: id})).body.proposal; };

test('proposals: drafted by any member, opened by someone else seconding, then everyone is emailed', async () => {
  const w = await world();
  assert.equal((await w.guest.proposals()).status, 401);
  assert.equal((await w.ana.proposals('create', {title: ''})).status, 400);
  assert.equal((await w.ana.proposals('create', {title: 'x', days: 90})).status, 400);
  const P = await propose(w);
  let p = (await w.ben.proposals('', undefined, {proposal: P})).body.proposal;
  assert.deepEqual([p.number, p.status, p.author, p.canSecond, p.canEdit], [1, 'draft', 'Ana', true, false]);
  assert.equal((await w.ben.proposals('vote', {proposal: P, vote: 'for'})).status, 409, 'no voting before it is seconded');
  assert.equal((await w.ana.proposals('second', {proposal: P})).status, 403, 'not by the proposer');
  assert.equal((await w.ben.proposals('update', {proposal: P, title: 'Mine'})).status, 403);
  assert.equal((await w.ana.proposals('update', {proposal: P, figure: '£6 a month each'})).status, 200);
  w.mailer.outbox.length = 0;
  assert.equal((await w.ben.proposals('second', {proposal: P})).status, 200);
  assert.equal((await w.cy.proposals('second', {proposal: P})).status, 409, 'already open');
  p = (await w.cy.proposals('', undefined, {proposal: P})).body.proposal;
  assert.deepEqual([p.status, p.seconder, p.figure, p.eligible, p.quorum], ['open', 'Ben', '£6 a month each', 4, 3]);
  assert.ok(Math.abs(p.closesAt - (Date.now() + 7 * DAY)) < 60000);
  assert.equal((await w.ana.proposals('update', {proposal: P, title: 'Changed'})).status, 409, 'locked once open');
  assert.deepEqual(w.mailer.outbox.map(m => m.to).sort(), ['ana@example.org', 'ben@example.org', 'cy@example.org', 'org@example.org']);
  assert.equal(w.mailer.outbox[0].subject, 'Vote: Shared press maintenance fund');
  const second = await propose(w, {title: 'Open studio on Saturdays', kind: 'Studio'});
  assert.equal((await w.cy.proposals()).body.drafts[0].id, second);
});

test('voting: change your vote until it closes, names are visible, votes from email are scanner-safe', async () => {
  const w = await world();
  const P = await propose(w);
  w.mailer.outbox.length = 0;
  await w.ben.proposals('second', {proposal: P});
  await w.ana.proposals('vote', {proposal: P, vote: 'for'});
  await w.ben.proposals('vote', {proposal: P, vote: 'against'});
  await w.ben.proposals('vote', {proposal: P, vote: 'abstain'});
  assert.equal((await w.ben.proposals('vote', {proposal: P, vote: 'maybe'})).status, 400);
  let p = (await w.cy.proposals('', undefined, {proposal: P})).body.proposal;
  assert.deepEqual(p.counts, {for: 1, against: 0, abstain: 1});
  assert.deepEqual(p.voters, [{name: 'Ana', vote: 'for'}, {name: 'Ben', vote: 'abstain'}]);
  assert.deepEqual(p.notVoted, ['Cy', 'Olu']);
  assert.equal(p.quorumMet, false);

  const mail = w.mailer.outbox.find(m => m.to === 'cy@example.org');
  const url = link('pvote', mail.html);
  assert.match((await visit(w.db, url)).text, /Vote For/);
  assert.equal((await w.cy.proposals('', undefined, {proposal: P})).body.proposal.myVote, '', 'opening the link votes nothing');
  assert.match((await visit(w.db, url, 'POST')).text, /Your vote: For/);
  p = (await w.cy.proposals('', undefined, {proposal: P})).body.proposal;
  assert.deepEqual([p.myVote, p.quorumMet], ['for', true]);
  await w.cy.proposals('vote', {proposal: P, vote: 'none'});
  assert.equal((await w.cy.proposals('', undefined, {proposal: P})).body.proposal.myVote, '');
});

test('results: no quorum, carried, not carried (a tie does not carry); closed proposals are locked', async () => {
  const w = await world();
  const vote = async (id, votes) => { for (const [who, v] of votes) await w[who].proposals('vote', {proposal: id, vote: v}); };
  const open = async title => { const id = await propose(w, {title}); await w.ben.proposals('second', {proposal: id}); return id; };
  const A = await open('Two votes'); await vote(A, [['ana', 'for'], ['ben', 'for']]);
  const B = await open('Carried'); await vote(B, [['ana', 'for'], ['ben', 'for'], ['cy', 'against']]);
  const C = await open('Tie'); await vote(C, [['ana', 'for'], ['ben', 'against'], ['cy', 'abstain']]);
  const D = await open('Abstentions count'); await vote(D, [['ana', 'for'], ['ben', 'abstain'], ['cy', 'abstain']]);
  assert.equal((await close(w, A)).status, 'no_quorum', '2 of 4 is not over half');
  const b = await close(w, B);
  assert.deepEqual([b.status, b.counts, b.eligible], ['carried', {for: 2, against: 1, abstain: 0}, 4]);
  assert.equal((await close(w, C)).status, 'not_carried');
  assert.equal((await close(w, D)).status, 'carried', 'abstaining counts toward the quorum');
  assert.equal((await w.org.proposals('vote', {proposal: B, vote: 'against'})).status, 409);
  const list = (await w.ana.proposals()).body;
  assert.deepEqual([list.open.length, list.closed.map(p => p.status)], [0, ['carried', 'not_carried', 'carried', 'no_quorum']]);
  assert.equal(await closeDue(w.db), 0, 'closing twice changes nothing');
});

test('reminders a day before closing, to people who haven’t voted, once; discussion by email; withdraw and delete', async () => {
  const w = await world();
  const P = await propose(w);
  await w.ben.proposals('second', {proposal: P});
  await w.ana.proposals('vote', {proposal: P, vote: 'for'});
  const run = async at => { w.mailer.outbox.length = 0; await remindProposals(w.db, w.mailer, ORIGIN, at); await flush(w.db, w.mailer, {now: at}); return w.mailer.outbox.map(m => m.to).sort(); };
  assert.deepEqual(await run(Date.now() + 2 * DAY), []);
  assert.deepEqual(await run(Date.now() + 6.2 * DAY), ['ben@example.org', 'cy@example.org', 'org@example.org']);
  assert.match(w.mailer.outbox[0].subject, /^Closes soon, not voted yet/);
  assert.deepEqual(await run(Date.now() + 6.5 * DAY), [], 'once');

  w.mailer.outbox.length = 0;
  const Q0 = await propose(w, {title: 'Second one'});
  await w.cy.proposals('second', {proposal: Q0});
  const mail = w.mailer.outbox.find(m => m.to === 'ben@example.org');
  const act = emailActions(w.db, {mailer: w.mailer, base: ORIGIN});
  assert.equal(await processMessage(w.db, raw('ben@example.org', mail.replyTo, 'Can we make it £4?'), act), 'comment: ok');

  assert.equal((await w.ben.proposals('withdraw', {proposal: P})).status, 403);
  assert.equal((await w.ana.proposals('withdraw', {proposal: P})).status, 200);
  assert.equal((await w.ana.proposals('', undefined, {proposal: P})).status, 404);
  const Q = (await w.ana.proposals()).body.open[0].id;
  assert.equal((await w.ana.proposals('delete', {proposal: Q})).status, 403, 'organizers only');
  assert.equal((await w.org.proposals('delete', {proposal: Q})).status, 200);
  assert.equal((await w.pg.query("SELECT count(*)::int n FROM comments WHERE kind='proposal'")).rows[0].n, 0);
});

test('feature switch: view-only members see but can’t propose, second or vote; off hides it', async () => {
  const w = await world();
  const P = await propose(w);
  await w.org.group('features', {proposals: 'view'});
  assert.equal((await w.ben.proposals('second', {proposal: P})).status, 403);
  assert.equal((await w.ben.proposals('create', {title: 'x'})).status, 403);
  assert.equal((await w.ben.proposals()).status, 200, 'still visible');
  assert.equal((await w.org.proposals('second', {proposal: P})).status, 200, 'organizers still can');
  assert.equal((await w.ben.proposals('vote', {proposal: P, vote: 'for'})).status, 403);
  await w.org.group('features', {proposals: 'off'});
  assert.equal((await w.ben.proposals()).status, 403);
  assert.deepEqual((await w.ben.group()).body.proposals, {open: [], drafts: []});
});
