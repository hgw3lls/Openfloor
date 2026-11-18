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
    const from = env.EMAIL_FROM?.trim() || `Open Floor <${user}>`;
    const port = Number(env.SMTP_PORT) || 465;
    return {
      async sendEach(messages) {
        const transport = nodemailer.createTransport({host: env.SMTP_HOST?.trim() || 'smtp.gmail.com', port,
          secure: port === 465, auth: {user, pass}, pool: true, maxConnections: 1});
        const results = [];
        try {
          for (const m of messages) {
            try {
              await transport.sendMail({from, to: m.to, replyTo, subject: m.subject, html: m.html, text: m.text, headers: m.headers});
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
          text: m.text, headers: m.headers, ...(replyTo ? {reply_to: replyTo} : {})}));
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

export const meetingLink = (base, meeting) => base + '/#' + meeting.id;
const action = (base, sub, a, extra = {}) => base + '/api/email?' + new URLSearchParams({a, t: sub.token, ...extra});

function when(meeting) {
  if (!meeting.starts_at) return meeting.schedule || '';
  return formatWhen(new Date(meeting.starts_at), meeting.timezone) + (meeting.location ? ' · ' + meeting.location : '');
}

function wrapEmail({meeting, sub, base, subject, html, text, unsubscribe = true}) {
  const unsub = unsubscribe ? action(base, sub, 'unsub') : '';
  const page = meetingLink(base, meeting);
  return {
    to: sub.email, subject,
    headers: unsub ? {'List-Unsubscribe': '<' + unsub + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'} : undefined,
    html: `<!doctype html><html><body style="margin:0;background:#f3f1e9;color:#211e24;font:16px/1.5 system-ui,sans-serif">
<div style="max-width:560px;margin:auto;padding:24px">
<p style="font:700 12px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:${purple};margin:0 0 8px">Open Floor</p>
<h1 style="font:normal 30px/1.1 Georgia,serif;margin:0 0 6px">${esc(meeting.title)}</h1>
${when(meeting) ? `<p style="margin:0 0 20px;color:#5a535f">${esc(when(meeting))}</p>` : ''}
${html}
<p style="margin:28px 0 0"><a href="${esc(page)}" style="color:${purple}">Open the meeting page</a></p>
<p style="margin:28px 0 0;font-size:13px;color:#5a535f">You get these emails because you signed up for updates on this meeting.${unsub ? ` <a href="${esc(unsub)}" style="color:#5a535f">Unsubscribe</a>` : ''}</p>
</div></body></html>`,
    text: `${meeting.title}\n${when(meeting)}\n\n${text}\n\nMeeting page: ${page}` + (unsub ? `\nUnsubscribe: ${unsub}` : '')
  };
}

const button = (href, label, filled = true) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:8px 14px;margin:0 6px 6px 0;border:1px solid ${purple};${filled ? `background:${purple};color:#fff` : `color:${purple}`};text-decoration:none;font-weight:700;font-size:14px">${label}</a>`;

export function confirmEmail({meeting, sub, base}) {
  const link = action(base, sub, 'confirm');
  return wrapEmail({meeting, sub, base, unsubscribe: false, subject: 'Confirm updates for ' + meeting.title,
    html: `<p>Someone (hopefully you) asked to get email updates for this meeting: new topics, voting, the agenda, a calendar invite and a reminder.</p>
<p>${button(link, 'Yes, send me updates')}</p><p style="color:#5a535f;font-size:14px">If you didn't ask for this, ignore this email and you won't hear from us again.</p>`,
    text: `Someone (hopefully you) asked to get email updates for this meeting.\nConfirm: ${link}\n\nIf you didn't ask for this, ignore this email.`});
}

function topicRows(topics, sub, base) {
  return topics.map(t => {
    const up = action(base, sub, 'vote', {topic: t.id, v: '1'}), down = action(base, sub, 'vote', {topic: t.id, v: '-1'});
    const own = !!t.author && t.author === sub.voter;
    return {
      html: `<div style="border-top:1px solid #c9c4b9;padding:14px 0">
<div style="font:700 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:${purple}">${esc(t.kind)}</div>
<strong>${esc(t.label)}</strong>${t.detail ? `<p style="margin:4px 0 0;white-space:pre-wrap">${esc(t.detail)}</p>` : ''}
${own ? `<p style="margin:10px 0 0;color:#5a535f;font-size:14px">Your topic</p>` : `<p style="margin:10px 0 0">${button(up, '👍 Up')}${button(down, '👎 Down', false)}</p>`}</div>`,
      text: `- ${t.label}${t.detail ? '\n  ' + t.detail.replace(/\n/g, '\n  ') : ''}` + (own ? '\n  (your topic)' : `\n  Up: ${up}\n  Down: ${down}`)
    };
  });
}

// Used for the topic digest and for "voting is open".
export function topicsEmail({meeting, sub, base, topics, subject, intro}) {
  const rows = topicRows(topics, sub, base);
  return wrapEmail({meeting, sub, base, subject,
    html: `<p>${esc(intro)}</p>${rows.map(r => r.html).join('')}`,
    text: `${intro}\n\n${rows.map(r => r.text).join('\n\n')}`});
}

function agendaBlock(meeting, base) {
  const agenda = JSON.parse(meeting.agenda || '[]');
  const total = agenda.reduce((sum, item) => sum + item.minutes, 0);
  const html = agenda.length ? `<p style="font:700 12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em">Agenda · ${total} minutes</p>` +
    agenda.map((item, i) => `<div style="border-top:1px solid #c9c4b9;padding:10px 0"><span style="color:${purple};font:700 12px ui-monospace,monospace">${i + 1}. ${esc(item.kind)} · ${item.minutes} min</span><br><strong>${esc(item.label)}</strong>${item.detail ? `<br><span style="white-space:pre-wrap">${esc(item.detail)}</span>` : ''}</div>`).join('') : '';
  const text = agenda.map((item, i) => `${i + 1}. ${item.label} (${item.kind}, ${item.minutes} min)${item.detail ? '\n   ' + item.detail : ''}`).join('\n');
  let calHtml = '', calText = '';
  if (meeting.starts_at) {
    const ics = base + '/api/calendar?meeting=' + meeting.id, google = googleLink(meeting, meetingLink(base, meeting));
    calHtml = `<p style="margin:20px 0 0">${button(ics, 'Add to calendar')}${button(google, 'Google Calendar', false)}</p>`;
    calText = `\n\nAdd to calendar: ${ics}\nGoogle Calendar: ${google}`;
  }
  return {html: html + calHtml, text: (text ? 'Agenda:\n' + text : '') + calText};
}

// kind: 'agenda' (published or updated), 'reminder' (day before), 'schedule' (date set)
export function agendaEmail({meeting, sub, base, kind}) {
  const block = agendaBlock(meeting, base);
  const intro = {agenda: 'The agenda is ready.', reminder: 'Reminder: this meeting is coming up soon.',
    schedule: 'The meeting time is set. Add it to your calendar.'}[kind];
  const subject = {agenda: 'Agenda: ', reminder: 'Reminder: ', schedule: 'Save the date: '}[kind] + meeting.title;
  return wrapEmail({meeting, sub, base, subject, html: `<p>${intro}</p>${block.html}`, text: `${intro}\n\n${block.text}`});
}

export function outcomesEmail({meeting, sub, base}) {
  return wrapEmail({meeting, sub, base, subject: 'Outcomes: ' + meeting.title,
    html: `<p>Decisions and next steps from the meeting:</p><div style="white-space:pre-wrap;border-left:3px solid ${purple};padding-left:12px">${esc(meeting.notes)}</div>`,
    text: `Decisions and next steps from the meeting:\n\n${meeting.notes}`});
}

// The public address used in every link people receive. APP_URL wins, so a
// link copied while on a private preview address still works for everyone.
export const appBase = request => process.env.APP_URL?.trim().replace(/\/$/, '')
  || (request ? new URL(request.url).origin
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : ''));
