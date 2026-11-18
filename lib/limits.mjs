// Simple rate limits stored in the database. Visitors are identified by a
// hash of their IP address, never the address itself.
import {createHash} from 'node:crypto';

export function visitor(request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update('openfloor:' + ip).digest('hex').slice(0, 24);
}

// Returns true if allowed (and records the hit), false if over the limit.
export async function allow(db, key, max, windowMs, now = Date.now()) {
  const {n} = await db.prepare('SELECT COUNT(*)::integer AS n FROM rate_events WHERE key=? AND at > ?').bind(key, now - windowMs).first();
  if (n >= max) return false;
  await db.prepare('INSERT INTO rate_events (key,at) VALUES (?,?)').bind(key, now).run();
  return true;
}

export async function prune(db, now = Date.now()) {
  await db.prepare('DELETE FROM rate_events WHERE at < ?').bind(now - 2 * 86400000).run();
}
