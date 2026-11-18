// Email sending (Gmail/SMTP or Resend) and the email templates. Email is
// optional: with no email settings the app works exactly as before.
import nodemailer from 'nodemailer';
import {formatWhen, googleLink} from './schedule.mjs';

// Gmail (or any SMTP server) when SMTP_USER and SMTP_PASS are set; otherwise
// Resend when RESEND_API_KEY and EMAIL_FROM are set; otherwise no email.
// sendEach(messages) returns one {ok, error} per message, in order.
export function createMailer(env = process.env) {
  const replyTo = env.EMAIL_REPLY_TO?.trim() || undefined;
  const user = env.SMTP_USER?.trim(), pass = env.SMTP_PASS?.replace(/\s+/g, '');
  if (user && pass) {
    const from = env.EMAIL_FROM?.trim() || `${env.GROUP_NAME?.trim() || 'Tower Press Artist Group'} <${user}>`;
    const port = Number(env.SMTP_PORT) || 465;
    return {
      async sendEach(messages) {
        const transport = nodemailer.createTransport({host: env.SMTP_HOST?.trim() || 'smtp.gmail.com', port,
          secure: port === 465, auth: {user, pass}, pool: true, maxConnections: 1});
        const results = [];
        try {
          for (const m of messages) {
            try {
              await transport.sendMail({from, to: m.to, replyTo: m.replyTo || replyTo, subject: m.subject, html: m.html, text: m.text, headers: m.headers});
              results.push({ok: true});
            } catch (error) { results.push({ok: false, error: error.code || error.responseCode || error.name}); }
          }
        } finally { transport.close(); }
        return results;
      }
    };
  }
  const key = env.RESEND_API_KEY?.trim(), from = env.EMAIL_FROM?.trim();
  if (!key || !from) return null;
  return {
    async sendEach(messages) {
      const results = [];
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        const batch = chunk.map(m => ({from, to: [m.to], subject: m.subject, html: m.html,
          text: m.text, headers: m.headers, ...(m.replyTo || replyTo ? {reply_to: m.replyTo || replyTo} : {})}));
        try {
          const response = await fetch('https://api.resend.com/emails/batch', {method: 'POST',
            headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: JSON.stringify(batch)});
          results.push(...chunk.map(() => response.ok ? {ok: true} : {ok: false, error: 'HTTP ' + response.status}));
        } catch (error) { results.push(...chunk.map(() => ({ok: false, error: error.name}))); }
      }
      return results;
    }
  };
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const purple = '#4d32ad';

export const groupName = () => process.env.GROUP_NAME?.trim() || 'Tower Press Artist Group';
export const meetingLink = (base, meeting) => base + '/#' + meeting.id;
const action = (base, sub, a, extra = {}) => base + '/api/email?' + new URLSearchParams({a, t: sub.token, ...extra});

function when(meeting) {
  if (!meeting.starts_at) return meeting.schedule || '';
  return formatWhen(new Date(meeting.starts_at), meeting.timezone) + (meeting.location ? ' · ' + meeting.location : '');
}

// The common email frame. `sub` is the recipient (a member: email + token).
function frame({sub, base, subject, heading, subline = '', html, text, page, pageLabel = 'Open the meeting page', unsubscribe = true, replyTo, replyHint}) {
  if (replyTo && replyHint) { html += `<p style="margin:20px 0 0;color:#5a535f;font-size:14px">${esc(replyHint)}</p>`; text += `\n\n${replyHint}`; }
  const unsub = unsubscribe ? action(base, sub, 'unsub') : '';
  return {
    to: sub.email, subject, ...(replyTo ? {replyTo} : {}),
    headers: unsub ? {'List-Unsubscribe': '<' + unsub + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'} : undefined,
    html: `<!doctype html><html><body style="margin:0;background:#f3f1e9;color:#211e24;font:16px/1.5 system-ui,sans-serif">
<div style="max-width:560px;margin:auto;padding:24px">
<p style="font:700 12px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:${purple};margin:0 0 8px">${esc(groupName())}</p>
<h1 style="font:normal 30px/1.1 Georgia,serif;margin:0 0 6px">${esc(heading)}</h1>
${subline ? `<p style="margin:0 0 20px;color:#5a535f">${esc(subline)}</p>` : ''}
${html}
${page ? `<p style="margin:28px 0 0"><a href="${esc(page)}" style="color:${purple}">${pageLabel}</a></p>` : ''}
<p style="margin:28px 0 0;font-size:13px;color:#5a535f">${unsub ? `You get these emails as a member of ${esc(groupName())}. <a href="${esc(unsub)}" style="color:#5a535f">Stop these emails</a>` : `Sent by ${esc(groupName())}.`}</p>
</div></body></html>`,
    text: `${heading}\n${subline}\n\n${text}` + (page ? `\n\n${pageLabel}: ${page}` : '') + (unsub ? `\nStop these emails: ${unsub}` : '')
  };
}

const meetingHint = 'Or just reply to this email: “yes”, “maybe” or “no, because …” to RSVP, “new topic: …” to suggest a topic, or anything else to add to the meeting’s discussion.';
const wrapEmail = ({meeting, sub, base, subject, html, text, replyTo, replyHint = meetingHint}) =>
  frame({sub, base, subject, heading: meeting.title, subline: when(meeting), html, text, page: meetingLink(base, meeting), replyTo, replyHint});

const button = (href, label, filled = true) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:8px 14px;margin:0 6px 6px 0;border:1px solid ${purple};${filled ? `background:${purple};color:#fff` : `color:${purple}`};text-decoration:none;font-weight:700;font-size:14px">${label}</a>`;

export const rsvpLabels = {yes: 'Going', maybe: 'Maybe', no: 'Can’t make it'};
function rsvpBlock(meeting, sub, base, question = 'Can you make it?') {
  const link = s => action(base, sub, 'rsvp', {m: meeting.id, s});
  return {
    html: `<p style="margin:20px 0 6px;font-weight:700">${esc(question)}</p><p style="margin:0">${button(link('yes'), rsvpLabels.yes)}${button(link('maybe'), rsvpLabels.maybe, false)}${button(link('no'), rsvpLabels.no, false)}</p>`,
    text: `${question}\nGoing: ${link('yes')}\nMaybe: ${link('maybe')}\nCan't make it: ${link('no')}`
  };
}

const mailto = (address, subject) => 'mailto:' + address + '?subject=' + encodeURIComponent(subject);
function topicRows(topics, sub, base) {
  return topics.map(t => {
    const reply = t.reply ? mailto(t.reply, 'Re: ' + t.label) : '';
    const up = action(base, sub, 'vote', {topic: t.id, v: '1'}), down = action(base, sub, 'vote', {topic: t.id, v: '-1'});
    const own = !!t.author && t.author === sub.voter;
    return {
      html: `<div style="border-top:1px solid #c9c4b9;padding:14px 0">
<div style="font:700 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:${purple}">${esc(t.kind)}</div>
<strong>${esc(t.label)}</strong>${t.detail ? `<p style="margin:4px 0 0;white-space:pre-wrap">${esc(t.detail)}</p>` : ''}
${own ? `<p style="margin:10px 0 0;color:#5a535f;font-size:14px">Your topic</p>` : `<p style="margin:10px 0 0">${button(up, '👍 Up')}${button(down, '👎 Down', false)}</p>`}${reply ? `<p style="margin:4px 0 0;font-size:14px"><a href="${esc(reply)}" style="color:${purple}">Reply with a comment</a></p>` : ''}</div>`,
      text: `- ${t.label}${t.detail ? '\n  ' + t.detail.replace(/\n/g, '\n  ') : ''}` + (own ? '\n  (your topic)' : `\n  Up: ${up}\n  Down: ${down}`)
    };
  });
}

// Used for the topic digest and for "voting is open".
export function topicsEmail({meeting, sub, base, topics, subject, intro, replyTo}) {
  const rows = topicRows(topics, sub, base);
  return wrapEmail({meeting, sub, base, subject, replyTo,
    html: `<p>${esc(intro)}</p>${rows.map(r => r.html).join('')}`,
    text: `${intro}\n\n${rows.map(r => r.text).join('\n\n')}`});
}

function calendarLinks(meeting, base) {
  if (!meeting.starts_at) return {html: '', text: ''};
  const ics = base + '/api/calendar?meeting=' + meeting.id, google = googleLink(meeting, meetingLink(base, meeting));
  return {html: `<p style="margin:20px 0 0">${button(ics, 'Add to calendar', false)}${button(google, 'Google Calendar', false)}</p>`,
    text: `\n\nAdd to calendar: ${ics}\nGoogle Calendar: ${google}`};
}

function agendaBlock(meeting, base) {
  const agenda = JSON.parse(meeting.agenda || '[]');
  const total = agenda.reduce((sum, item) => sum + item.minutes, 0);
  const html = agenda.length ? `<p style="font:700 12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em">Agenda · ${total} minutes</p>` +
    agenda.map((item, i) => `<div style="border-top:1px solid #c9c4b9;padding:10px 0"><span style="color:${purple};font:700 12px ui-monospace,monospace">${i + 1}. ${esc(item.kind)} · ${item.minutes} min</span><br><strong>${esc(item.label)}</strong>${item.detail ? `<br><span style="white-space:pre-wrap">${esc(item.detail)}</span>` : ''}</div>`).join('') : '';
  const text = agenda.map((item, i) => `${i + 1}. ${item.label} (${item.kind}, ${item.minutes} min)${item.detail ? '\n   ' + item.detail : ''}`).join('\n');
  const cal = calendarLinks(meeting, base);
  return {html: html + cal.html, text: (text ? 'Agenda:\n' + text : '') + cal.text};
}

// kind: 'agenda' (published or updated), 'reminder' (day before)
export function agendaEmail({meeting, sub, base, kind, replyTo}) {
  const block = agendaBlock(meeting, base), rsvp = rsvpBlock(meeting, sub, base, kind === 'reminder' ? 'Still coming? Update your RSVP:' : 'Can you make it?');
  const intro = {agenda: 'The agenda is ready.', reminder: 'Reminder: this meeting is coming up soon.'}[kind];
  const subject = {agenda: 'Agenda: ', reminder: 'Reminder: '}[kind] + meeting.title;
  return wrapEmail({meeting, sub, base, subject, replyTo, html: `<p>${intro}</p>${block.html}${rsvp.html}`, text: `${intro}\n\n${block.text}\n\n${rsvp.text}`});
}

// kind: 'new' (meeting announced), 'schedule' (time changed), 'nudge' (no RSVP yet)
export function meetingEmail({meeting, sub, base, kind, replyTo}) {
  const rsvp = rsvpBlock(meeting, sub, base), cal = calendarLinks(meeting, base);
  const intro = {new: 'A new meeting is on the calendar. Let us know if you can make it, and suggest topics on the meeting page.',
    schedule: 'The meeting time has changed. Please check you can still make it.',
    nudge: 'We haven’t heard from you yet. Can you make this meeting?'}[kind];
  const subject = {new: 'New meeting: ', schedule: 'Time changed: ', nudge: 'Can you make it? '}[kind] + meeting.title;
  return wrapEmail({meeting, sub, base, subject, replyTo, html: `<p>${esc(intro)}</p>${rsvp.html}${cal.html}`, text: `${intro}\n\n${rsvp.text}${cal.text}`});
}

export const dueLabel = due => due ? new Date(due + 'T12:00:00Z').toLocaleDateString('en-US', {timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'}) : '';

export function outcomesEmail({meeting, sub, base, replyTo, actions = []}) {
  const items = actions.map(a => `<li style="margin:4px 0"><strong>${esc(a.title)}</strong>${a.ownerName ? ' · ' + esc(a.ownerName) : ''}${a.due ? ' · due ' + esc(dueLabel(a.due)) : ''}</li>`).join('');
  const itemsText = actions.map(a => `- ${a.title}${a.ownerName ? ' (' + a.ownerName + ')' : ''}${a.due ? ', due ' + dueLabel(a.due) : ''}`).join('\n');
  return wrapEmail({meeting, sub, base, subject: 'Outcomes: ' + meeting.title, replyTo, replyHint: 'Reply to this email to add to the meeting’s discussion.',
    html: (meeting.notes ? `<p>Decisions and next steps from the meeting:</p><div style="white-space:pre-wrap;border-left:3px solid ${purple};padding-left:12px">${esc(meeting.notes)}</div>` : '') +
      (items ? `<p style="margin:20px 0 4px;font-weight:700">Action items</p><ul style="padding-left:20px;margin:0">${items}</ul>` : ''),
    text: (meeting.notes ? `Decisions and next steps from the meeting:\n\n${meeting.notes}` : '') + (itemsText ? `\n\nAction items:\n${itemsText}` : '')});
}

// kind: 'assigned', 'soon' (due in 2 days), 'today', 'overdue'
export function actionEmail({sub, base, action, meeting, kind, replyTo}) {
  const done = action ? base + '/api/email?' + new URLSearchParams({a: 'done', t: sub.token, action: action.id}) : '';
  const due = action.due ? dueLabel(action.due) : '';
  const intro = {assigned: `You have a new action item from ${meeting.title}.`, soon: `Reminder: this is due ${due}.`,
    today: 'Reminder: this is due today.', overdue: `This was due ${due}. If it’s done, mark it done; if not, it will come up at the next meeting.`}[kind];
  const subject = {assigned: 'Action item: ', soon: 'Due soon: ', today: 'Due today: ', overdue: 'Overdue: '}[kind] + action.title;
  return frame({sub, base, subject, heading: action.title, subline: (due ? 'Due ' + due + ' · ' : '') + 'From ' + meeting.title,
    html: `<p>${esc(intro)}</p><p>${button(done, 'Mark done')}</p>`, text: `${intro}\n\nMark done: ${done}`,
    page: meetingLink(base, meeting), replyTo, replyHint: 'Or reply “done” to this email. Anything else you write goes to the meeting’s discussion.'});
}

const who = m => m?.name || m?.email?.split('@')[0] || 'Someone';
const para = text => esc(text).replace(/\n/g, '<br>');

export function postEmail({sub, base, post, author, replyTo}) {
  return frame({sub, base, subject: post.title, heading: post.title, subline: 'Posted by ' + who(author),
    html: post.body ? `<p style="white-space:pre-wrap">${para(post.body)}</p>` : '', text: post.body || '',
    page: base + '/#post/' + post.id, pageLabel: 'Open the post', replyTo, replyHint: 'Reply to this email to comment.'});
}

export function commentEmail({sub, base, thread, author, body, replyTo}) {
  return frame({sub, base, subject: 'Re: ' + thread.title, heading: thread.title, subline: who(author) + ' replied',
    html: `<div style="white-space:pre-wrap;border-left:3px solid ${purple};padding-left:12px">${para(body)}</div>`, text: body,
    page: base + '/' + thread.path, pageLabel: 'Open the conversation', replyTo, replyHint: 'Reply to this email to answer.'});
}

// The daily or weekly summary: new topics to vote on, posts, and replies.
export function digestEmail({sub, base, period, meetings = [], posts = [], comments = []}) {
  const parts = [], text = [];
  const section = title => { parts.push(`<h2 style="font:normal 22px Georgia,serif;margin:28px 0 4px">${esc(title)}</h2>`); text.push('\n== ' + title + ' =='); };
  for (const {meeting, topics} of meetings) {
    section('New topics for ' + meeting.title);
    const rows = topicRows(topics, sub, base);
    parts.push(rows.map(r => r.html).join('')); text.push(rows.map(r => r.text).join('\n\n'));
  }
  if (posts.length) {
    section('New posts');
    for (const p of posts) {
      const link = base + '/#post/' + p.id, reply = p.reply ? mailto(p.reply, 'Re: ' + p.title) : '';
      parts.push(`<div style="border-top:1px solid #c9c4b9;padding:14px 0"><strong><a href="${esc(link)}" style="color:#211e24">${esc(p.title)}</a></strong><br><span style="color:#5a535f;font-size:14px">${esc(who(p.author))}</span>${p.body ? `<p style="margin:6px 0 0;white-space:pre-wrap">${para(p.body.slice(0, 600))}${p.body.length > 600 ? '…' : ''}</p>` : ''}${reply ? `<p style="margin:6px 0 0;font-size:14px"><a href="${esc(reply)}" style="color:${purple}">Reply</a></p>` : ''}</div>`);
      text.push(`- ${p.title} (${who(p.author)})\n  ${link}`);
    }
  }
  if (comments.length) {
    section('New replies');
    for (const c of comments) {
      const link = base + '/' + c.thread.path, reply = c.reply ? mailto(c.reply, 'Re: ' + c.thread.title) : '';
      parts.push(`<div style="border-top:1px solid #c9c4b9;padding:12px 0"><span style="font-size:14px;color:#5a535f">${esc(who(c.author))} on <a href="${esc(link)}" style="color:${purple}">${esc(c.thread.title)}</a></span><p style="margin:4px 0 0;white-space:pre-wrap">${para(c.body.slice(0, 500))}${c.body.length > 500 ? '…' : ''}</p>${reply ? `<p style="margin:4px 0 0;font-size:14px"><a href="${esc(reply)}" style="color:${purple}">Reply</a></p>` : ''}</div>`);
      text.push(`- ${who(c.author)} on ${c.thread.title}: ${c.body.slice(0, 200)}\n  ${link}`);
    }
  }
  const label = period === 'weekly' ? 'This week' : 'Today';
  return frame({sub, base, subject: `${label} at ${groupName()}`, heading: label + ' in the group',
    html: parts.join(''), text: text.join('\n'), page: base + '/', pageLabel: 'Open ' + groupName()});
}

// Group emails (not about one meeting).
export function inviteEmail({member, base}) {
  const link = action(base, member, 'confirm');
  return frame({sub: member, base, unsubscribe: false, subject: 'You’re invited to ' + groupName(), heading: 'Join ' + groupName(),
    html: `<p>You’ve been added to the ${esc(groupName())} member list. Members get meeting invitations, can RSVP and suggest topics, and vote on what we talk about.</p><p>${button(link, 'Join the group')}</p><p style="color:#5a535f;font-size:14px">If you don’t want to join, ignore this email and you won’t hear from us.</p>`,
    text: `You've been added to the ${groupName()} member list.\nJoin: ${link}\n\nIf you don't want to join, ignore this email.`});
}

export function signinEmail({member, base, code, welcome = false}) {
  const link = base + '/api/email?' + new URLSearchParams({a: 'signin', c: code});
  const intro = welcome ? `You’re in! Your request to join ${groupName()} was approved.` : `Here’s your link to sign in to ${groupName()}.`;
  return frame({sub: member, base, unsubscribe: false, subject: welcome ? 'Welcome to ' + groupName() : 'Your sign-in link', heading: welcome ? 'Welcome' : 'Sign in',
    html: `<p>${esc(intro)}</p><p>${button(link, 'Sign in')}</p><p style="color:#5a535f;font-size:14px">The link works once and expires in ${welcome ? '7 days' : '30 minutes'}. If you didn’t ask for it, ignore this email.</p>`,
    text: `${intro}\nSign in: ${link}\n\nThe link works once and expires in ${welcome ? '7 days' : '30 minutes'}.`});
}

export function joinRequestEmail({organizer, applicant, base}) {
  return frame({sub: organizer, base, unsubscribe: false, subject: `${applicant.name || applicant.email} wants to join`, heading: 'New join request',
    html: `<p><strong>${esc(applicant.name)}</strong> (${esc(applicant.email)}) asked to join ${esc(groupName())}.</p>`,
    text: `${applicant.name} (${applicant.email}) asked to join ${groupName()}.`, page: base + '/#members', pageLabel: 'Review requests'});
}

// The public address used in every link people receive. APP_URL wins, so a
// link copied while on a private preview address still works for everyone.
export const appBase = request => process.env.APP_URL?.trim().replace(/\/$/, '')
  || (request ? new URL(request.url).origin
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : ''));
