// Handles the links inside emails: join, sign in, RSVP, vote and unsubscribe.
// Opening a link (GET) only shows a page with a button; the change happens on
// POST. Email security scanners open links automatically, so a GET must never
// cast a vote, RSVP, or sign anyone in. Unsubscribe also accepts the one-click
// POST that Gmail and Yahoo send (RFC 8058).
import {addComment, addTopic, castVote, setRsvp} from './actions.mjs';
import {startSession, useSigninCode} from './auth.mjs';
import {appBase, groupName, meetingLink, rsvpLabels} from './email.mjs';
import {check} from './features.mjs';
import {formatWhen} from './schedule.mjs';
import {welcome} from './welcome.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');

function page(title, body, status = 200, cookie) {
  const response = new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · ${esc(groupName())}</title>
<meta name="theme-color" content="#211e24"><link rel="stylesheet" href="/fonts/fonts.css">
<style>:root{color-scheme:dark;--ink:#211e24;--paper:#f3f1e9;--lime:#def38e;--rule:rgba(243,241,233,.35)}
body{margin:0;background:var(--ink);color:var(--paper);font:17px/1.5 Geist,system-ui,sans-serif}main{max-width:520px;margin:auto;padding:28px 20px 48px}
h1{font:700 44px/.9 Geist,system-ui,sans-serif;letter-spacing:-.055em;text-transform:uppercase;margin:0 0 16px;padding-bottom:16px;border-bottom:3px solid var(--paper);overflow-wrap:anywhere}
.k{display:flex;align-items:center;gap:9px;font:800 15px Geist,system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 34px}.k:before{content:"";width:12px;height:12px;background:var(--lime);transform:rotate(-12deg)}
form.inline{display:inline}button{font:700 12px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;border:2px solid var(--lime);background:var(--lime);color:var(--ink);padding:0 18px;margin:0 8px 8px 0;cursor:pointer;min-height:50px;border-radius:0}
button.alt{background:transparent;color:var(--lime)}button:focus-visible,a:focus-visible,textarea:focus-visible,input:focus-visible{outline:3px solid var(--paper);outline-offset:3px}a{color:var(--lime)}
.topic{border:1.5px solid var(--rule);padding:14px;margin:16px 0}
label{display:block;margin:0 0 10px}fieldset{border:0;padding:0;margin:0 0 16px}legend{font:700 11px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--lime);margin-bottom:10px}
input[type=radio],input[type=checkbox]{accent-color:var(--lime);width:18px;height:18px;vertical-align:-3px;margin-right:6px}
input[type=text]{display:block;width:100%;box-sizing:border-box;min-height:46px;border:1.5px solid var(--paper);background:transparent;color:var(--paper);padding:8px 12px;font:inherit;margin-top:6px;border-radius:0}
.row{border-top:1px solid var(--rule);padding:12px 0}.row label{display:inline-block;margin:6px 18px 0 0}.err{color:#e8a6a0}
textarea{display:block;width:100%;box-sizing:border-box;min-height:90px;border:1.5px solid var(--paper);background:transparent;color:var(--paper);padding:10px 12px;font:inherit;margin-top:6px;border-radius:0}
.muted{color:var(--paper);opacity:.72}strong{color:var(--lime)}</style>
<main><p class="k">${esc(groupName())}</p>${body}</main></html>`, {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'}});
  if (cookie) response.headers.append('Set-Cookie', cookie);
  return response;
}

// `mailer` is only checked to decide whether to queue the welcome email;
// api/email.js sends the queue afterwards.
export async function links(request, db, now = Date.now(), mailer = null) {
  const url = new URL(request.url), base = appBase(request);
  const a = url.searchParams.get('a'), token = url.searchParams.get('t') || '';
  const run = (sql, ...args) => db.prepare(sql).bind(...args);
  const post = request.method === 'POST';
  // A form on another site can't sign someone in here (into the wrong account)
  // or accept an invite for them: those POSTs just show the page with the button.
  const crossSite = post && request.headers.get('sec-fetch-site') === 'cross-site';
  if (!post && request.method !== 'GET') return page('Unavailable', '<h1>Unavailable</h1>', 405);
  const form = (label, params, alt = false) => `<form class="inline" method="post" action="/api/email?${esc(new URLSearchParams(params))}"><button${alt ? ' class="alt"' : ''}>${label}</button></form>`;
  const home = `<p><a href="${esc(base + '/')}">Go to ${esc(groupName())}</a></p>`;

  if (a === 'signin') {
    const code = url.searchParams.get('c') || '';
    if (!post || crossSite) return page('Sign in', `<h1>Sign in</h1><p>Sign in to ${esc(groupName())} on this device.</p><p>${form('Sign in', {a, c: code})}</p>`);
    const member = await useSigninCode(db, code, now);
    if (!member) return page('Link expired', `<h1>This link has expired</h1><p>Sign-in links work once and expire after 30 minutes. Ask for a new one on the site.</p>${home}`, 410);
    if (member.status === 'invited') {
      await run("UPDATE members SET status='active' WHERE id=?", member.id).run();
      if (mailer) await welcome(db, member, base, {now});
    }
    const response = new Response(null, {status: 303, headers: {Location: base + '/', 'Cache-Control': 'no-store'}});
    response.headers.append('Set-Cookie', await startSession(db, member.id, now));
    return response;
  }

  if (!/^[a-f0-9]{64}$/.test(token)) return page('Link not valid', '<h1>This link isn’t valid</h1><p>It may be incomplete. Try opening it from the email again.</p>', 404);
  const member = await run("SELECT * FROM members WHERE token=? AND status<>'removed'", token).first();
  if (!member) return page('Link expired', `<h1>This link has expired</h1><p>You may no longer be on the member list.</p>${home}`, 404);

  if (a === 'confirm') {
    if (post && !crossSite) {
      if (!['invited', 'active'].includes(member.status)) return page('Not available', `<h1>This invitation is no longer open</h1>${home}`, 409);
      await run("UPDATE members SET status='active' WHERE id=?", member.id).run();
      if (member.status === 'invited' && mailer) await welcome(db, member, base, {now});
      return page('Welcome', `<h1>You’re in</h1><p>Welcome to ${esc(groupName())}. You’ll get meeting invitations and can RSVP, suggest topics and vote. You’re signed in on this device.</p>${home}`, 200, await startSession(db, member.id, now));
    }
    return page('Join', `<h1>Join ${esc(groupName())}?</h1><p>${form('Join the group', {a, t: token})}</p>`);
  }
  if (a === 'unsub') {
    if (post) {
      await run("UPDATE members SET emails='none' WHERE id=?", member.id).run();
      return page('Unsubscribed', `<h1>Emails stopped</h1><p>You won’t get more emails from ${esc(groupName())}. You can turn them back on any time from your settings on the site.</p>${home}`);
    }
    return page('Stop emails', `<h1>Stop emails?</h1><p>You’ll stay a member, but won’t get meeting invitations or updates by email.</p><p>${form('Stop emails', {a, t: token})}</p>`);
  }
  if (member.status !== 'active') return page('Not a member yet', `<h1>You’re not a member yet</h1><p>Accept your invitation first.</p>${home}`, 403);

  if (a === 'call') {
    const callId = url.searchParams.get('call');
    const call = uuid(callId) && await run('SELECT * FROM calls WHERE id=? AND hidden=false', callId).first();
    if (!call) return page('Not found', `<h1>That call is gone</h1>${home}`, 404);
    const {interestLabels, setInterest} = await import('./calls.mjs');
    const status = interestLabels[url.searchParams.get('s')] ? url.searchParams.get('s') : 'interested';
    const callHome = `<p><a href="${esc(base + '/#call/' + call.id)}">Open the call</a></p>`;
    const head = `<h1>${esc(call.title)}</h1><p class="muted">${esc([call.kind, call.organization, 'Deadline ' + call.deadline].filter(Boolean).join(' · '))}</p>`;
    if (post) {
      const result = await setInterest(db, member.id, call.id, status, now);
      if (result.error) return page('Not available', `${head}<p>${esc(result.error)}</p>${callHome}`, result.status);
      return page('Saved', `${head}<p><strong>Saved: ${esc(interestLabels[status])}.</strong>${status === 'applied' ? ' Good luck!' : ' You’ll get reminders a week and a day before the deadline.'}</p>${callHome}`);
    }
    return page('Open call', `${head}<p>${form('Mark me as ' + interestLabels[status].toLowerCase(), {a, t: token, call: call.id, s: status})}</p>${callHome}`);
  }

  if (a === 'pvote') {
    const pid = url.searchParams.get('proposal');
    const p = uuid(pid) && await run("SELECT * FROM proposals WHERE id=? AND status<>'withdrawn'", pid).first();
    if (!p) return page('Not found', `<h1>That proposal is gone</h1>${home}`, 404);
    const {voteLabels, castProposalVote} = await import('./proposals.mjs');
    const vote = voteLabels[url.searchParams.get('v')] ? url.searchParams.get('v') : 'for';
    const pHome = `<p><a href="${esc(base + '/#proposal/' + p.id)}">Open the proposal</a></p>`;
    const head = `<h1>${esc(p.title)}</h1><p class="muted">Proposal P-${p.number} · ${esc(p.kind)}</p>`;
    if (post) {
      const result = await castProposalVote(db, member.id, p.id, vote, now);
      if (result.error) return page('Not available', `${head}<p>${esc(result.error)}</p>${pHome}`, result.status);
      return page('Vote saved', `${head}<p><strong>Your vote: ${esc(voteLabels[vote])}.</strong> You can change it on the site until voting closes.</p>${pHome}`);
    }
    return page('Vote', `${head}<p>${form('Vote ' + voteLabels[vote], {a, t: token, proposal: p.id, v: vote})}</p>${pHome}`);
  }

  if (a === 'going') {
    const eventId = url.searchParams.get('event');
    const ev = uuid(eventId) && await run('SELECT * FROM events WHERE id=? AND hidden=false', eventId).first();
    if (!ev) return page('Not found', `<h1>That event is gone</h1>${home}`, 404);
    const evHome = `<p><a href="${esc(base + '/#event/' + ev.id)}">Open the event</a></p>`;
    const head = `<h1>${esc(ev.title)}</h1><p class="muted">${esc(formatWhen(new Date(ev.starts_at), ev.timezone))}${ev.location ? ' · ' + esc(ev.location) : ''}</p>`;
    if (post) {
      const {setGoing} = await import('./events.mjs');
      const result = await setGoing(db, member.id, ev.id, true, now);
      if (result.error) return page('Not available', `${head}<p>${esc(result.error)}</p>${evHome}`, result.status);
      return page('See you there', `${head}<p><strong>You’re going.</strong> It’s on the event page and in your calendar link.</p>${evHome}`);
    }
    return page('Going?', `${head}<p>${form('I’m going', {a, t: token, event: ev.id})}</p>${evHome}`);
  }

  if (a === 'claim' || a === 'unclaim') {
    const slotId = url.searchParams.get('slot');
    const slot = uuid(slotId) && await run(`SELECT s.*,e.id AS event_id,e.title,e.starts_at AS event_start,e.timezone,e.location FROM slots s JOIN events e ON e.id=s.event
      WHERE s.id=? AND e.hidden=false`, slotId).first();
    if (!slot) return page('Not found', `<h1>That slot is gone</h1>${home}`, 404);
    const eventHome = `<p><a href="${esc(base + '/#event/' + slot.event_id)}">Open the event</a></p>`;
    const when = formatWhen(new Date(slot.starts_at ?? slot.event_start), slot.timezone);
    const head = `<h1>${esc(slot.label)}</h1><p class="muted">${esc(slot.title)} · ${esc(when)}${slot.location ? ' · ' + esc(slot.location) : ''}</p>`;
    const {claimSlot, unclaimSlot} = await import('./events.mjs');
    if (post) {
      const result = a === 'claim' ? await claimSlot(db, member.id, slot.id, now) : await unclaimSlot(db, member.id, slot.id);
      if (result.error) return page('Not available', `${head}<p><strong>${esc(result.error)}</strong></p>${eventHome}`, result.status);
      return page(a === 'claim' ? 'Signed up' : 'Removed', `${head}<p><strong>${a === 'claim' ? 'You’re signed up. Thank you! You’ll get a reminder the day before.' : 'You’re off this slot.'}</strong></p>${eventHome}`);
    }
    return page(a === 'claim' ? 'Sign up' : 'Drop out', `${head}<p>${form(a === 'claim' ? 'Sign me up' : 'Take me off this slot', {a, t: token, slot: slot.id}, a !== 'claim')}</p>${eventHome}`);
  }

  if (a === 'done') {
    const actionId = url.searchParams.get('action');
    const item = uuid(actionId) && await run('SELECT a.*,m.title AS meeting_title FROM actions a JOIN meetings m ON m.id=a.meeting WHERE a.id=?', actionId).first();
    if (!item) return page('Not found', `<h1>Action item not found</h1>${home}`, 404);
    const meetingHome = `<p><a href="${esc(meetingLink(base, {id: item.meeting}))}">Open the meeting page</a></p>`;
    if (item.owner !== member.id) return page('Not yours', `<h1>This isn’t your action item</h1>${meetingHome}`, 403);
    const head = `<h1>${esc(item.title)}</h1><p class="muted">From ${esc(item.meeting_title)}</p>`;
    if (post) {
      const undo = new URLSearchParams(await request.text()).get('undo') === '1';
      await run('UPDATE actions SET status=?, done_at=? WHERE id=?', undo ? 'open' : 'done', undo ? 0 : now, item.id).run();
      return page(undo ? 'Reopened' : 'Done', `${head}<p><strong>${undo ? 'Marked as not done.' : 'Marked done. Thank you!'}</strong></p>${undo ? '' : `<form method="post" action="/api/email?${esc(new URLSearchParams({a, t: token, action: item.id}))}"><input type="hidden" name="undo" value="1"><button class="alt">Undo</button></form>`}${meetingHome}`);
    }
    return page('Mark done', `${head}${item.status === 'done' ? '<p>This is already marked done.</p>' : `<p>${form('Mark done', {a, t: token, action: item.id})}</p>`}${meetingHome}`);
  }

  const meetingId = url.searchParams.get('m') || '';
  if (a === 'rsvp') {
    const meeting = uuid(meetingId) && await run('SELECT * FROM meetings WHERE id=?', meetingId).first();
    if (!meeting) return page('Meeting not found', `<h1>Meeting not found</h1>${home}`, 404);
    const meetingHome = `<p><a href="${esc(meetingLink(base, meeting))}">Open the meeting page</a></p>`;
    const when = meeting.starts_at ? formatWhen(new Date(meeting.starts_at), meeting.timezone) + (meeting.location ? ' · ' + meeting.location : '') : meeting.schedule;
    const head = `<h1>${esc(meeting.title)}</h1>${when ? `<p class="muted">${esc(when)}</p>` : ''}`;
    let status = url.searchParams.get('s'), reason = '', error = '';
    if (post) {
      const body = new URLSearchParams(await request.text());
      status = body.get('status'); reason = (body.get('reason') || '').trim().slice(0, 500);
      if (!['yes', 'maybe', 'no'].includes(status)) error = 'Choose Going, Maybe or Can’t make it.';
      else if (status === 'no' && reason.length < 3) error = 'Please say why you can’t make it.';
      else {
        const result = await setRsvp(db, member.id, meeting.id, status, reason, now);
        if (result.error) return page('Not available', `${head}<p><strong>${esc(result.error)}</strong></p>${meetingHome}`, result.status);
        return page('RSVP saved', `${head}<p><strong>Thanks! You’re marked: ${esc(rsvpLabels[status])}.</strong></p><p class="muted">Plans change? Use the link in the email again, or the meeting page.</p>${meetingHome}`);
      }
    } else {
      const current = await run('SELECT status,reason FROM rsvps WHERE meeting=? AND member=?', meeting.id, member.id).first();
      if (!['yes', 'maybe', 'no'].includes(status)) status = current?.status ?? '';
      reason = current?.reason ?? '';
    }
    const option = s => `<label><input type="radio" name="status" value="${s}"${status === s ? ' checked' : ''}> ${esc(rsvpLabels[s])}</label>`;
    return page('RSVP', `${head}<form method="post" action="/api/email?${esc(new URLSearchParams({a, t: token, m: meeting.id}))}">
<fieldset><legend>Can you make it?</legend>${option('yes')}${option('maybe')}${option('no')}</fieldset>
<label>Reason <span class="muted">(needed if you can’t make it; only organizers see it)</span><textarea name="reason" maxlength="500">${esc(reason)}</textarea></label>
${error ? `<p style="color:#7b2055">${esc(error)}</p>` : ''}<button>Save RSVP</button></form>${meetingHome}`, error ? 400 : 200);
  }

  // One page for everything a meeting invite asks: RSVP, a vote on each topic,
  // a new topic and a comment, sent with one button.
  if (a === 'answer') {
    const meeting = uuid(meetingId) && await run('SELECT * FROM meetings WHERE id=?', meetingId).first();
    if (!meeting) return page('Meeting not found', `<h1>Meeting not found</h1>${home}`, 404);
    const meetingHome = `<p><a href="${esc(meetingLink(base, meeting))}">Open the meeting page</a></p>`;
    const when = meeting.starts_at ? formatWhen(new Date(meeting.starts_at), meeting.timezone) + (meeting.location ? ' · ' + meeting.location : '') : meeting.schedule;
    const head = `<h1>${esc(meeting.title)}</h1>${when ? `<p class="muted">${esc(when)}</p>` : ''}`;
    const voter = 'm:' + member.id;
    const canVote = meeting.phase !== 'agenda' && !await check(db, member.id, 'topics');
    const canSuggest = meeting.phase === 'collect' && canVote;
    const canComment = !await check(db, member.id, 'comments');
    const topics = canVote ? (await run(`SELECT t.id,t.label,t.detail,t.kind,t.author,COALESCE(b.value,0) AS mine FROM topics t
      LEFT JOIN ballots b ON b.topic=t.id AND b.voter=? WHERE t.meeting=? AND t.hidden=false ORDER BY t.created`, voter, meeting.id).all()).results : [];
    const current = await run('SELECT status,reason FROM rsvps WHERE meeting=? AND member=?', meeting.id, member.id).first();
    const v = {status: current?.status ?? '', reason: current?.reason ?? '', label: '', detail: '', comment: ''};
    const votes = Object.fromEntries(topics.map(t => [t.id, Number(t.mine)]));
    let error = '';
    if (post) {
      const body = new URLSearchParams(await request.text());
      for (const k of ['status', 'reason', 'label', 'detail', 'comment']) v[k] = (body.get(k) || '').trim();
      for (const t of topics) if (t.author !== voter && body.has('v:' + t.id)) votes[t.id] = Number(body.get('v:' + t.id));
      if (v.status && !['yes', 'maybe', 'no'].includes(v.status)) v.status = '';
      if (v.status === 'no' && v.reason.length < 3) error = 'Please say why you can’t make it.';
      else if (!v.status && !v.label && !v.comment && topics.every(t => votes[t.id] === Number(t.mine))) error = 'Nothing to send yet: choose an answer first.';
      if (!error) {
        const saved = [], problems = [];
        const note = (result, done) => result?.error ? problems.push(result.error) : saved.push(done);
        if (v.status && (v.status !== current?.status || (v.status !== 'yes' && v.reason !== current?.reason)))
          note(await setRsvp(db, member.id, meeting.id, v.status, v.reason, now), `RSVP: ${rsvpLabels[v.status]}`);
        let changed = 0;
        for (const t of topics) {
          if (t.author === voter || ![1, 0, -1].includes(votes[t.id]) || votes[t.id] === Number(t.mine)) continue;
          const result = await castVote(db, member.id, t.id, votes[t.id]);
          if (result.error) problems.push(result.error); else changed++;
        }
        if (changed) saved.push(changed === 1 ? '1 vote' : `${changed} votes`);
        if (v.label && canSuggest) note(await addTopic(db, member.id, meeting.id, {label: v.label, detail: v.detail}, now), `Your topic: ${v.label.slice(0, 120)}`);
        if (v.comment && canComment) note(await addComment(db, member.id, {kind: 'meeting', target: meeting.id, body: v.comment, via: 'email'}, {mailer, base, now}), 'Your comment');
        const again = `<p><a href="${esc('/api/email?' + new URLSearchParams({a, t: token, m: meeting.id}))}">Change your answers</a></p>`;
        return page('Answers saved', `${head}${saved.length ? `<p><strong>Thanks! Saved:</strong></p><ul>${saved.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p>Nothing changed.</p>'}` +
          (problems.length ? `<p class="err">Not saved: ${esc(problems.join(' '))}</p>` : '') + again + meetingHome);
      }
    }
    const radio = (name, value, label, on) => `<label><input type="radio" name="${esc(name)}" value="${esc(value)}"${on ? ' checked' : ''}> ${label}</label>`;
    const rsvp = `<fieldset><legend>Can you make it?</legend>${['yes', 'maybe', 'no'].map(s => radio('status', s, esc(rsvpLabels[s]), v.status === s)).join('')}
<label>Reason <span class="muted">(needed if you can’t make it; only organizers see it)</span><textarea name="reason" maxlength="500">${esc(v.reason)}</textarea></label></fieldset>`;
    const rows = topics.map(t => `<div class="row"><div class="k" style="margin:0 0 4px">${esc(t.kind)}</div><strong>${esc(t.label)}</strong>${t.detail ? `<div style="white-space:pre-wrap">${esc(t.detail)}</div>` : ''}<div>` +
      (t.author === voter ? '<span class="muted">Your topic</span>' : [[1, '👍 Up'], [-1, '👎 Down'], [0, 'No vote']].map(([n, l]) => radio('v:' + t.id, n, l, votes[t.id] === n)).join('')) + '</div></div>').join('');
    const vote = topics.length ? `<fieldset><legend>Vote on the topics</legend>${rows}</fieldset>` : '';
    const suggest = canSuggest ? `<fieldset><legend>Suggest a topic</legend><label>Title <span class="muted">(optional)</span><input type="text" name="label" maxlength="120" value="${esc(v.label)}"></label>
<label>Details <span class="muted">(optional)</span><textarea name="detail" maxlength="650">${esc(v.detail)}</textarea></label></fieldset>` : '';
    const comment = canComment ? `<fieldset><legend>Add to the discussion</legend><label>Comment <span class="muted">(optional; everyone in the group can see it)</span><textarea name="comment" maxlength="3000">${esc(v.comment)}</textarea></label></fieldset>` : '';
    return page('Your answers', `${head}<form method="post" action="/api/email?${esc(new URLSearchParams({a, t: token, m: meeting.id}))}">${rsvp}${vote}${suggest}${comment}
${error ? `<p class="err">${esc(error)}</p>` : ''}<button>Send</button></form>${meetingHome}`, error ? 400 : 200);
  }

  if (a === 'vote') {
    const topicId = url.searchParams.get('topic');
    const topic = uuid(topicId) && await run(`SELECT t.id,t.label,t.detail,t.kind,t.author,t.meeting,m.title,m.phase FROM topics t JOIN meetings m ON m.id=t.meeting
      WHERE t.id=? AND t.hidden=false`, topicId).first();
    if (!topic) return page('Topic not found', `<h1>Topic not found</h1>${home}`, 404);
    const meetingHome = `<p><a href="${esc(meetingLink(base, {id: topic.meeting}))}">Open the meeting page</a></p>`;
    const title = `<p>${esc(topic.title)}</p>`;
    const voterId = 'm:' + member.id;
    if (topic.author === voterId) return page('Your topic', `<h1>This is your topic</h1>${title}<p>You can’t vote on a topic you suggested.</p>${meetingHome}`, 403);
    if (topic.phase === 'agenda') return page('Voting closed', `<h1>Voting has closed</h1>${title}<p>The agenda has been published.</p>${meetingHome}`, 409);
    let value = Number(url.searchParams.get('v'));
    if (![1, -1, 0].includes(value)) value = 1;
    let done = '';
    if (post) {
      const result = await castVote(db, member.id, topic.id, value);
      if (result.error) return page('Not available', `<h1>${esc(result.error)}</h1>${title}${meetingHome}`, result.status);
      done = value === 0 ? 'Your vote was removed.' : `Your vote was saved: ${value > 0 ? '👍 up' : '👎 down'}.`;
    }
    const current = (await run('SELECT value FROM ballots WHERE topic=? AND voter=?', topic.id, voterId).first())?.value ?? 0;
    const card = `<div class="topic"><div class="k">${esc(topic.kind)}</div><strong>${esc(topic.label)}</strong>${topic.detail ? `<p style="white-space:pre-wrap;margin:6px 0 0">${esc(topic.detail)}</p>` : ''}</div>`;
    const params = v => ({a, t: token, topic: topic.id, v: String(v)});
    const buttons = post
      ? `<p>${current > 0 ? form('👎 Change to down', params(-1), true) : current < 0 ? form('👍 Change to up', params(1), true) : ''}${current ? form('Remove vote', params(0), true) : ''}</p>`
      : `<p>${form(value > 0 ? '👍 Vote up' : '👎 Vote down', params(value))}${form(value > 0 ? '👎 Down instead' : '👍 Up instead', params(-value), true)}</p>`;
    return page('Vote', `<h1>${post ? esc(done) : 'Confirm your vote'}</h1>${title}${card}${buttons}${meetingHome}`);
  }
  return page('Link not valid', '<h1>This link isn’t valid</h1>', 404);
}
