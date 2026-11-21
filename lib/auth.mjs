// Members sign in with a link sent by email: no passwords. The link opens a
// page with a button (a GET never signs anyone in, so email scanners can't),
// and the button sets a session cookie that lasts a year.
// Only hashes of session ids and sign-in codes are stored.
import {createHash, randomBytes} from 'node:crypto';

const YEAR = 365 * 86400000, CODE_LIFE = 30 * 60000;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

function cookieValue(request, name) {
  return request.headers.get('Cookie')?.match(new RegExp('(?:^|; )' + name + '=([a-f0-9]{64})(?:;|$)'))?.[1];
}

// The signed-in member for this request, or null.
export async function currentMember(request, db, now = Date.now()) {
  const id = cookieValue(request, 'session');
  if (!id) return null;
  return await db.prepare(`SELECT m.* FROM sessions s JOIN members m ON m.id=s.member
    WHERE s.id=? AND s.expires > ? AND m.status='active'`).bind(hash(id), now).first() ?? null;
}

export async function startSession(db, memberId, now = Date.now()) {
  const id = newToken();
  await db.prepare('INSERT INTO sessions (id,member,created,expires) VALUES (?,?,?,?)').bind(hash(id), memberId, now, now + YEAR).run();
  return `session=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${YEAR / 1000}`;
}

export async function endSession(request, db) {
  const id = cookieValue(request, 'session');
  if (id) await db.prepare('DELETE FROM sessions WHERE id=?').bind(hash(id)).run();
  return 'session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
}

export async function createSigninCode(db, memberId, now = Date.now(), life = CODE_LIFE) {
  const code = newToken();
  await db.prepare('INSERT INTO signin_codes (id,member,expires) VALUES (?,?,?)').bind(hash(code), memberId, now + life).run();
  return code;
}

// A 6-digit code for the same sign-in, to type in where the link can't reach,
// like an app saved to an iPhone home screen (it doesn't share Safari's sign-in).
const shortId = (memberId, digits) => hash('short:' + memberId + ':' + digits);
export async function createShortCode(db, memberId, now = Date.now()) {
  const digits = String(randomBytes(4).readUInt32BE() % 1000000).padStart(6, '0');
  await db.prepare('INSERT INTO signin_codes (id,member,expires,short) VALUES (?,?,?,true) ON CONFLICT (id) DO NOTHING').bind(shortId(memberId, digits), memberId, now + CODE_LIFE).run();
  return digits;
}
export async function useShortCode(db, email, digits, now = Date.now()) {
  if (!/^\d{6}$/.test(digits ?? '')) return null;
  const member = await db.prepare("SELECT * FROM members WHERE email=? AND status IN ('active','invited')").bind(email).first();
  if (!member) return null;
  const row = await db.prepare("UPDATE signin_codes SET used=true WHERE id=? AND used=false AND expires > ? RETURNING member").bind(shortId(member.id, digits), now).first();
  return row ? member : null;
}

// After too many wrong guesses, every 6-digit code for that address stops working.
export async function burnShortCodes(db, email) {
  await db.prepare("UPDATE signin_codes SET used=true WHERE short AND used=false AND member=(SELECT id FROM members WHERE email=?)").bind(email).run();
}

// Returns the member for an unused, unexpired code and marks it used.
export async function useSigninCode(db, code, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(code ?? '')) return null;
  const row = await db.prepare("UPDATE signin_codes SET used=true WHERE id=? AND used=false AND expires > ? RETURNING member")
    .bind(hash(code), now).first();
  if (!row) return null;
  return await db.prepare("SELECT * FROM members WHERE id=? AND status IN ('active','invited')").bind(row.member).first() ?? null;
}

export async function pruneAuth(db, now = Date.now()) {
  await db.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run();
  await db.prepare('DELETE FROM signin_codes WHERE expires < ?').bind(now - 86400000).run();
}
