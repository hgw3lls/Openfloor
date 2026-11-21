// The welcome email goes out once per member, the first time they become
// active: accepting an invitation, signing in from one, or being approved.
import {welcomeEmail} from './email.mjs';
import {getFeatures} from './features.mjs';
import {enqueue} from './outbox.mjs';

export async function welcome(db, member, base, {signin = '', now = Date.now()} = {}) {
  const first = await db.prepare('UPDATE members SET welcomed=? WHERE id=? AND welcomed=0 RETURNING id').bind(now, member.id).first();
  if (!first) return false;
  await enqueue(db, '', [welcomeEmail({member, base, features: await getFeatures(db), signin, organizer: member.role === 'organizer'})], now);
  return true;
}
