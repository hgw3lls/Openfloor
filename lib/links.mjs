// Handles the links inside emails: join, sign in, RSVP, vote and unsubscribe.
// Opening a link (GET) only shows a page with a button; the change happens on
// POST. Email security scanners open links automatically, so a GET must never
// cast a vote, RSVP, or sign anyone in. Unsubscribe also accepts the one-click
// POST that Gmail and Yahoo send (RFC 8058).
import {castVote, setRsvp} from './actions.mjs';
import {startSession, useSigninCode} from './auth.mjs';
import {appBase, groupName, meetingLink, rsvpLabels} from './email.mjs';
import {formatWhen} from './schedule.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');

function page(title, body, status = 200, cookie) {
  const response = new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · ${esc(groupName())}</title>
<style>body{margin:0;background:#f3f1e9;color:#211e24;font:17px/1.5 system-ui,sans-serif}main{max-width:520px;margin:auto;padding:48px 20px}
h1{font:normal 2.2rem/1.05 Georgia,serif;letter-spacing:-.03em;margin:0 0 14px}.k{font:700 .75rem ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#4d32ad}
form.inline{display:inline}button{font:700 1rem system-ui;border:1px solid #4d32ad;background:#4d32ad;color:#fff;padding:12px 18px;margin:0 8px 8px 0;cursor:pointer;min-height:48px}
button.alt{background:transparent;color:#4d32ad}a{color:#4d32ad}.topic{border:1px solid #c9c4b9;background:#faf9f3;padding:14px;margin:16px 0}
label{display:block;margin:0 0 10px}fieldset{border:0;padding:0;margin:0 0 16px}legend{font-weight:700;margin-bottom:8px}
textarea{display:block;width:100%;box-sizing:border-box;min-height:90px;border:1px solid #8b8491;padding:9px 11px;font:inherit;margin-top:4px}.muted{color:#5a535f}</style>
<main><p class="k">${esc(groupName())}</p>${body}</main></html>`, {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'}});
  if (cookie) response.headers.append('Set-Cookie', cookie);
  return response;
}

export async function links(request, db, now = Date.now()) {
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
    if (member.status === 'invited') await run("UPDATE members SET status='active' WHERE id=?", member.id).run();
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
