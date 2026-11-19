// Features organizers can turn off or make view-only for members.
// Organizers always have everything. RSVPs and action items are always on.
export const featureList = [
  {key: 'topics', label: 'Meeting topics and voting', full: 'Suggest topics and vote', view: 'See topics and how they’re doing, but not suggest or vote', off: 'Topic lists hidden (members still see the agenda and RSVP)'},
  {key: 'posts', label: 'Posts', full: 'Read and write posts', view: 'Read posts only', off: 'Posts hidden'},
  {key: 'comments', label: 'Discussions and replies', full: 'Read and reply, on the site or by email', view: 'Read discussions only', off: 'Discussions hidden'},
  {key: 'events', label: 'Events', full: 'See and add events', view: 'See events only', off: 'Events hidden'},
  {key: 'signups', label: 'Volunteer sign-ups', full: 'Sign up for slots', view: 'See slots and who’s signed up', off: 'Sign-up slots hidden'},
  {key: 'calls', label: 'Open calls', full: 'Share calls and mark interest', view: 'See calls only', off: 'Open calls hidden'},
];
export const levels = ['full', 'view', 'off'];
const keys = featureList.map(f => f.key);
const rank = {off: 0, view: 1, full: 2};

// What members get, feature by feature (default: everything).
export async function getFeatures(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key='features'").bind().first();
  let saved = {};
  try { saved = JSON.parse(row?.value || '{}'); } catch {}
  return Object.fromEntries(keys.map(k => [k, levels.includes(saved[k]) ? saved[k] : 'full']));
}

export async function setFeatures(db, input) {
  const next = {...await getFeatures(db)};
  for (const k of keys) if (levels.includes(input?.[k])) next[k] = input[k];
  await db.prepare(`INSERT INTO settings (key,value) VALUES ('features',?) ON CONFLICT (key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(next)).run();
  return next;
}

export const levelFor = (features, role, key) => role === 'organizer' ? 'full' : features[key] ?? 'full';
export const allows = (features, role, key, level = 'full') => rank[levelFor(features, role, key)] >= rank[level];

const names = Object.fromEntries(featureList.map(f => [f.key, f.label]));
export const blocked = (features, key) => ({status: 403,
  error: features[key] === 'off' ? `${names[key]} are turned off for this group.` : `${names[key]} are view-only for members right now.`});

// For the shared actions (site, email links and email replies), which only know the member's id.
export async function check(db, memberId, key, level = 'full') {
  const [features, m] = [await getFeatures(db), await db.prepare('SELECT role FROM members WHERE id=?').bind(memberId).first()];
  return allows(features, m?.role, key, level) ? null : blocked(features, key);
}

// SQL to add to a member query so a feature that's off only emails organizers.
export async function audience(db, ...featureKeys) {
  const features = await getFeatures(db);
  return featureKeys.some(k => features[k] === 'off') ? " AND role='organizer'" : '';
}
