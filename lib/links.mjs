// Handles the links inside emails: confirm, unsubscribe and vote.
// Opening a link (GET) only shows a page with a button; the change happens on
// POST. Email security scanners open links automatically, so a GET must never
// cast a vote or confirm a subscription. Unsubscribe also accepts the
// one-click POST that Gmail and Yahoo send (RFC 8058).
import {meetingLink, appBase} from './email.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Open Floor</title>
<style>body{margin:0;background:#f3f1e9;color:#211e24;font:17px/1.5 system-ui,sans-serif}main{max-width:520px;margin:auto;padding:48px 20px}
h1{font:normal 2.2rem/1.05 Georgia,serif;letter-spacing:-.03em;margin:0 0 14px}.k{font:700 .75rem ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#4d32ad}
form{display:inline}button{font:700 1rem system-ui;border:1px solid #4d32ad;background:#4d32ad;color:#fff;padding:12px 18px;margin:0 8px 8px 0;cursor:pointer;min-height:48px}
button.alt{background:transparent;color:#4d32ad}a{color:#4d32ad}.topic{border:1px solid #c9c4b9;background:#faf9f3;padding:14px;margin:16px 0}</style>
<main><p class="k">Open Floor</p>${body}</main></html>`, {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'}});
}

export async function links(request, db) {
  const url = new URL(request.url);
  const a = url.searchParams.get('a'), token = url.searchParams.get('t') || '';
  const run = (sql, ...args) => db.prepare(sql).bind(...args);
  if (!/^[a-f0-9]{64}$/.test(token)) return page('Link not valid', '<h1>This link isn’t valid</h1><p>It may be incomplete. Try opening it from the email again.</p>', 404);
  const sub = await run('SELECT s.*,m.title,m.phase FROM subscribers s JOIN meetings m ON m.id=s.meeting WHERE s.token=?', token).first();
  if (!sub) return page('Link expired', '<h1>This link has expired</h1><p>You may have been removed from this meeting’s email list.</p>', 404);
  const home = `<p><a href="${esc(meetingLink(appBase(request), {id: sub.meeting}))}">Open the meeting page</a></p>`;
  const title = `<p>${esc(sub.title)}</p>`;
  const post = request.method === 'POST';
  if (!post && request.method !== 'GET') return page('Unavailable', '<h1>Unavailable</h1>', 405);
  const form = (label, extra = {}, alt = false) => `<form method="post" action="/api/email?${esc(new URLSearchParams({a, t: token, ...extra}))}"><button${alt ? ' class="alt"' : ''}>${label}</button></form>`;

  // The browser cookie links this email address to the person's votes and
  // topics on the site, so they can't vote twice or on their own topics.
  const cookie = request.headers.get('Cookie')?.match(/(?:^|; )floor=([a-f0-9-]{36})(?:;|$)/)?.[1];
  if (a === 'confirm') {
    if (post) {
      await run("UPDATE subscribers SET status='active', voter=CASE WHEN voter='' AND ? <> '' THEN ? ELSE voter END WHERE id=?",
        cookie ? 'c:' + cookie : '', cookie ? 'c:' + cookie : '', sub.id).run();
      return page('Subscribed', `<h1>You’re on the list</h1>${title}<p>You’ll get new topics, voting, the agenda with a calendar invite, and a reminder before the meeting.</p>${home}`);
    }
    return page('Confirm', `<h1>Get email updates?</h1>${title}<p>${form('Yes, send me updates')}</p>`);
  }
  if (a === 'unsub') {
    if (post) {
      await run("UPDATE subscribers SET status='unsubscribed' WHERE id=?", sub.id).run();
      return page('Unsubscribed', `<h1>You’re unsubscribed</h1>${title}<p>You won’t get more emails about this meeting.</p>${home}`);
    }
    return page('Unsubscribe', `<h1>Stop email updates?</h1>${title}<p>${form('Unsubscribe')}</p>`);
  }
  if (a === 'vote') {
    const topicId = url.searchParams.get('topic');
    const topic = uuid(topicId) && await run('SELECT id,label,detail,kind,author FROM topics WHERE id=? AND meeting=? AND hidden=false', topicId, sub.meeting).first();
    if (!topic) return page('Topic not found', `<h1>Topic not found</h1>${title}${home}`, 404);
    // Votes from email count as the same person as their votes on the site.
    const voterId = sub.voter || 's:' + sub.id;
    if (topic.author && topic.author === voterId) return page('Your topic', `<h1>This is your topic</h1>${title}<p>You can’t vote on a topic you suggested.</p>${home}`, 403);
    if (sub.status !== 'active') return page('Not subscribed', `<h1>You’re not on the email list</h1>${title}<p>You can still vote on the meeting page.</p>${home}`, 403);
    if (sub.phase === 'agenda') return page('Voting closed', `<h1>Voting has closed</h1>${title}<p>The agenda has been published.</p>${home}`, 409);
    let value = Number(url.searchParams.get('v'));
    if (![1, -1, 0].includes(value)) value = 1;
    let done = '';
    if (post) {
      if (voterId !== 's:' + sub.id) await run('DELETE FROM ballots WHERE topic=? AND voter=?', topic.id, 's:' + sub.id).run();
      if (value === 0) await run('DELETE FROM ballots WHERE topic=? AND voter=?', topic.id, voterId).run();
      else await run(`INSERT INTO ballots (topic,meeting,voter,value) VALUES (?,?,?,?) ON CONFLICT (topic,voter) DO UPDATE SET value=excluded.value`,
        topic.id, sub.meeting, voterId, value).run();
      done = value === 0 ? 'Your vote was removed.' : `Your vote was saved: ${value > 0 ? '👍 up' : '👎 down'}.`;
    }
    const current = (await run('SELECT value FROM ballots WHERE topic=? AND voter=?', topic.id, voterId).first())?.value ?? 0;
    const card = `<div class="topic"><div class="k">${esc(topic.kind)}</div><strong>${esc(topic.label)}</strong>${topic.detail ? `<p style="white-space:pre-wrap;margin:6px 0 0">${esc(topic.detail)}</p>` : ''}</div>`;
    const buttons = post
      ? `<p>${current > 0 ? form('👎 Change to down', {topic: topic.id, v: '-1'}, true) : current < 0 ? form('👍 Change to up', {topic: topic.id, v: '1'}, true) : ''}${current ? form('Remove vote', {topic: topic.id, v: '0'}, true) : ''}</p>`
      : `<p>${form(value > 0 ? '👍 Vote up' : '👎 Vote down', {topic: topic.id, v: String(value)})}${form(value > 0 ? '👎 Down instead' : '👍 Up instead', {topic: topic.id, v: String(-value)}, true)}</p>`;
    return page('Vote', `<h1>${post ? esc(done) : 'Confirm your vote'}</h1>${title}${card}${buttons}${home}`);
  }
  return page('Link not valid', '<h1>This link isn’t valid</h1>', 404);
}
