// Reply by email. Each email a member gets carries a personal reply address
// on the group's Gmail (Gmail delivers user+anything@gmail.com to user@):
//   towerpressartistgroup+k<key>@gmail.com
// The key says who the member is and what they're replying to (a post, a
// topic or a meeting). The inbox is read over IMAP; each reply becomes a
// comment, a vote, an RSVP or a new topic.
import {createHash, randomBytes} from 'node:crypto';
import {simpleParser} from 'mailparser';

const INBOX_EVERY = 4 * 60000;

// Reply addresses need Gmail (or another mailbox that supports +addresses and IMAP).
export function inboundEnabled(env = process.env) {
  return !!(env.SMTP_USER?.trim() && env.SMTP_PASS?.trim() && env.INBOUND !== 'off');
}
export function replyAddress(key, env = process.env) {
  if (!key || !inboundEnabled(env)) return null;
  const [local, domain] = env.SMTP_USER.trim().split('@');
  return `${local}+k${key}@${domain}`;
}

// One key per member and thing, reused for every email about it.
export async function replyKey(db, memberId, kind, target, now = Date.now()) {
  const existing = await db.prepare('SELECT key FROM reply_keys WHERE member=? AND kind=? AND target=?').bind(memberId, kind, target).first();
  if (existing) return existing.key;
  const key = randomBytes(10).toString('hex');
  await db.prepare('INSERT INTO reply_keys (key,member,kind,target,created) VALUES (?,?,?,?,?) ON CONFLICT (member,kind,target) DO NOTHING')
    .bind(key, memberId, kind, target, now).run();
  return (await db.prepare('SELECT key FROM reply_keys WHERE member=? AND kind=? AND target=?').bind(memberId, kind, target).first()).key;
}

// The reply text without the quoted email, signatures and phone footers.
export function replyText(text) {
  let t = String(text ?? '').replace(/\r\n/g, '\n');
  const cuts = [
    /\n[^\n]*On [^\n]{3,200}(\n[^\n]{0,200})?wrote:\s*\n/,      // Gmail / Apple Mail, sometimes over two lines
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{5,}\n/,                                                // Outlook separator
    /\nFrom: [^\n]+\n(Sent|Date): /,                            // Outlook header block
    /\n-- \n/,                                                  // signature
    /\nSent from my [^\n]+/i,
    /\nGet Outlook for [^\n]+/i
  ];
  for (const cut of cuts) { const m = cut.exec('\n' + t); if (m) t = ('\n' + t).slice(0, m.index).slice(1); }
  t = t.split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
}

// Shortcuts at the start of a reply.
export function shortcut(kind, text) {
  const [first, ...rest] = text.split('\n');
  const line = first.trim(), more = rest.join('\n').trim();
  if (kind === 'topic') {
    if (/^(\+1|👍|up)\b|^\+1|^👍/i.test(line)) return {vote: 1, comment: more};
    if (/^(-1|👎|down)\b|^-1|^👎/i.test(line)) return {vote: -1, comment: more};
  }
  if (kind === 'action' && /^(done|finished|completed|complete|✅|did it)\b|^✅/i.test(line)) return {done: true, comment: more};
  if (kind === 'meeting') {
    const topic = /^new topic\s*[:\-–]\s*(.+)$/i.exec(line);
    if (topic) return {topic: {label: topic[1].trim().slice(0, 120), detail: more.slice(0, 650)}};
    const after = s => s.replace(/^[\s,.:;!\-–—]+/, '').replace(/^(because|since|as)\s+/i, '');
    let m;
    if ((m = /^(yes|yep|going|i'?m in|count me in|i'?ll be there)\b(.*)$/i.exec(line))) return {rsvp: 'yes', reason: ''};
    if ((m = /^(maybe|not sure|possibly)\b(.*)$/i.exec(line))) return {rsvp: 'maybe', reason: [after(m[2]), more].filter(Boolean).join('\n')};
    if ((m = /^(no|nope|can'?t make it|cannot make it|can not make it|can'?t come|won'?t make it|can'?t|cannot|can not|not coming|won'?t)\b(.*)$/i.exec(line))) {
      return {rsvp: 'no', reason: [after(m[2]), more].filter(Boolean).join('\n') || 'Replied “no” by email without a reason.'};
    }
  }
  return {comment: text};
}

// Did Gmail verify that the message really came from the From domain?
// Gmail adds its own Authentication-Results header above everything else, so
// only the first one from Gmail counts: a sender can write their own
// "dmarc=pass" lower down, and that must not be believed.
export function senderVerified(authResults, fromAddress, authserv = 'mx.google.com') {
  const domain = fromAddress.split('@')[1]?.toLowerCase();
  const list = (Array.isArray(authResults) ? authResults : [authResults]).map(v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
  const results = list.find(v => v.split(';')[0].trim() === authserv);
  if (!domain || !results) return false;
  const aligned = d => d === domain || d.endsWith('.' + domain);
  const dmarc = [...results.matchAll(/dmarc=pass[^;]*header\.from=([a-z0-9.-]+)/g)].map(m => m[1]);
  const dkim = [...results.matchAll(/dkim=pass[^;]*header\.(?:i|d)=@?([a-z0-9.-]+)/g)].map(m => m[1]);
  const spf = [...results.matchAll(/spf=pass[^;]*smtp\.mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/g)].map(m => m[1]);
  return [...dmarc, ...dkim, ...spf].some(aligned);
}

// Handles one raw email. `act` does the work (comment/vote/rsvp/topic) so the
// same rules apply as on the site. Returns a short outcome for logging.
export async function processMessage(db, raw, act, env = process.env) {
  const mail = await simpleParser(raw);
  const header = name => mail.headers.get(name);
  const auto = String(header('auto-submitted') ?? 'no').toLowerCase();
  if (auto !== 'no' || header('x-autoreply') || /auto_reply|bulk|junk|list/i.test(String(header('precedence') ?? ''))) return 'ignored: automatic message';
  const from = mail.from?.value?.[0]?.address?.toLowerCase();
  if (!from || from === env.SMTP_USER?.trim().toLowerCase()) return 'ignored: from ourselves';
  const recipients = [mail.to, mail.cc, {value: [{address: header('delivered-to')}]}].flatMap(a => (Array.isArray(a) ? a : [a])).flatMap(a => a?.value ?? []).map(v => v.address ?? '');
  const key = recipients.map(a => /\+k([a-f0-9]{20})@/i.exec(a)?.[1]).find(Boolean)?.toLowerCase();
  if (!key) return 'ignored: no reply key';
  const target = await db.prepare(`SELECT k.kind,k.target,m.id AS member,m.email,m.status FROM reply_keys k JOIN members m ON m.id=k.member WHERE k.key=?`).bind(key).first();
  if (!target || target.status !== 'active') return 'ignored: unknown key';
  if (target.email !== from) return 'ignored: sender is not the member';
  // In the order they appear, top first.
  const authResults = (mail.headerLines ?? []).filter(h => h.key === 'authentication-results').map(h => h.line.replace(/^[^:]*:/, ''));
  if (env.INBOUND_SKIP_AUTH !== '1' && !senderVerified(authResults, from, env.INBOUND_AUTHSERV?.trim().toLowerCase() || 'mx.google.com')) return 'ignored: sender not verified';
  const text = replyText(mail.text ?? '');
  if (!text) return 'ignored: empty';
  // The same email can be read twice (e.g. a check that ran long). Handle it once.
  const messageId = String(mail.messageId ?? '').trim();
  if (messageId) {
    const id = createHash('sha256').update(key + ':' + messageId).digest('hex');
    const fresh = await db.prepare('INSERT INTO replies_seen (id,at) VALUES (?,?) ON CONFLICT (id) DO NOTHING RETURNING id').bind(id, Date.now()).first();
    if (!fresh) return 'ignored: already handled';
  }
  const intent = shortcut(target.kind, text);
  return act({member: target.member, kind: target.kind, target: target.target, ...intent});
}

// Reads unread replies from the group inbox (at most every 4 minutes).
export async function pollInbox(db, act, {env = process.env, now = Date.now(), force = false, Imap} = {}) {
  if (!inboundEnabled(env)) return {skipped: 'inbound off'};
  const claimed = await db.prepare(`INSERT INTO settings (key,value) VALUES ('inbox_polled',?)
    ON CONFLICT (key) DO UPDATE SET value=excluded.value WHERE settings.value::bigint < ? RETURNING value`)
    .bind(String(now), force ? now + 1 : now - INBOX_EVERY).first();
  if (!claimed) return {skipped: 'polled recently'};
  const ImapFlow = Imap ?? (await import('imapflow')).ImapFlow;
  const client = new ImapFlow({host: env.IMAP_HOST?.trim() || 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: {user: env.SMTP_USER.trim(), pass: env.SMTP_PASS.replace(/\s+/g, '')}});
  const report = {read: 0, done: []};
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = await client.search({seen: false, to: '+k'}, {uid: true}) || [];
    for (const uid of uids.slice(0, 50)) {
      const message = await client.fetchOne(String(uid), {source: true}, {uid: true});
      let outcome;
      try { outcome = message?.source ? await processMessage(db, message.source, act, env) : 'ignored: could not fetch'; }
      catch (error) { outcome = 'error: ' + (error.code ?? error.name); }
      report.read++; report.done.push(outcome);
      await client.messageFlagsAdd(String(uid), ['\\Seen'], {uid: true});
    }
  } finally { lock.release(); await client.logout().catch(() => {}); }
  return report;
}
