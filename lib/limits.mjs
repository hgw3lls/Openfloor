// Simple rate limits stored in the database. Visitors are identified by a
// hash of their IP address, never the address itself.
import {createHash} from 'node:crypto';

export function visitor(request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update('openfloor:' + ip).digest('hex').slice(0, 24);
}

// Returns true if allowed (and records the hit), false if over the limit.
// One statement counts and checks together, so many requests sent at once
// can't all slip in under the limit. Each window is a fixed time bucket.
export async function allow(db, key, max, windowMs, now = Date.now()) {
  const bucket = Math.floor(now / windowMs);
  const row = await db.prepare(`INSERT INTO rate_counts (key,bucket,n,expires) VALUES (?,?,1,?)
    ON CONFLICT (key,bucket) DO UPDATE SET n=rate_counts.n+1 WHERE rate_counts.n < ? RETURNING n`)
    .bind(key, bucket, (bucket + 1) * windowMs, max).first();
  return Boolean(row);
}

export async function prune(db, now = Date.now()) {
  await db.prepare('DELETE FROM rate_counts WHERE expires < ?').bind(now).run();
  await db.prepare('DELETE FROM rate_events WHERE at < ?').bind(now - 2 * 86400000).run();
  await db.prepare('DELETE FROM replies_seen WHERE at < ?').bind(now - 30 * 86400000).run();
}
