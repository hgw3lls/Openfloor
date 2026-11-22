// The group's logo, uploaded by organizers. Off by default: the group name is
// shown as text. Two images can be uploaded:
//   wide:   for the top of pages, emails and email-link pages
//   square: for the sign-in page (a round or square badge)
// Images live in the settings table (base64) and are served by
// /api/group?logo=<slot>&v=<version>, so they work in emails too.
import {groupName} from './email.mjs';

export const SLOTS = ['wide', 'square'];
export const MAX_BYTES = 500 * 1024;
const TYPES = {png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46, 0x38], webp: [0x52, 0x49, 0x46, 0x46]};

const read = async (db, key) => (await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value;
const write = (db, key, value) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value').bind(key, value).run();

// {on, wide: {v, type} | null, square: {v, type} | null}
export async function getBranding(db) {
  let saved = {};
  try { saved = JSON.parse(await read(db, 'branding') || '{}'); } catch {}
  return {on: saved.on === true, ...Object.fromEntries(SLOTS.map(s => [s, saved[s]?.v ? {v: saved[s].v, type: saved[s].type} : null]))};
}

export const logoUrl = (branding, slot, base = '') => branding[slot] ? `${base}/api/group?logo=${slot}&v=${branding[slot].v}` : '';

// What the site needs: the image addresses, only when the logo is on.
export function publicBranding(branding) {
  return Object.fromEntries(SLOTS.map(s => [s, branding.on ? logoUrl(branding, s) : '']));
}
// What the organizer panel needs: the setting and both images either way.
export function adminBranding(branding) {
  return {on: branding.on, ...Object.fromEntries(SLOTS.map(s => [s, logoUrl(branding, s)]))};
}

// A data: URL from the browser -> {type, bytes}, or {error}.
export function parseImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ''));
  if (!m) return {error: 'Upload a PNG, JPG, GIF or WebP image.'};
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) return {error: 'That image is empty.'};
  if (bytes.length > MAX_BYTES) return {error: 'That image is too big. Keep it under 500 KB.'};
  if (!TYPES[m[1]].every((b, i) => bytes[i] === b)) return {error: 'That file isn’t the image type it says it is.'};
  return {type: 'image/' + m[1], bytes};
}

// input: {on?: boolean, wide?: dataURL, square?: dataURL, remove?: 'wide'|'square'}
export async function setBranding(db, input, now = Date.now()) {
  const current = await getBranding(db);
  const next = {on: typeof input?.on === 'boolean' ? input.on : current.on, wide: current.wide, square: current.square};
  for (const slot of SLOTS) {
    if (!input?.[slot]) continue;
    const image = parseImage(input[slot]);
    if (image.error) return image;
    await write(db, 'logo:' + slot, image.bytes.toString('base64'));
    next[slot] = {v: now, type: image.type};
  }
  if (SLOTS.includes(input?.remove)) {
    await db.prepare('DELETE FROM settings WHERE key=?').bind('logo:' + input.remove).run();
    next[input.remove] = null;
  }
  await write(db, 'branding', JSON.stringify(next));
  return {ok: true, branding: adminBranding({...next, on: next.on})};
}

export async function logoResponse(db, slot) {
  const branding = await getBranding(db);
  const data = SLOTS.includes(slot) && branding[slot] && await read(db, 'logo:' + slot);
  if (!data) return new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store'}});
  return new Response(Buffer.from(data, 'base64'), {headers: {'Content-Type': branding[slot].type, 'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'"}});
}

// Emails and email-link pages are written with the group name between these
// markers; swapLogo puts the uploaded wide logo there when it's switched on.
export const nameMark = (html, base = '') => `<!--logo:${base}-->${html}<!--/logo-->`;
export function swapLogo(html, branding, {width = 270} = {}) {
  if (!branding.on || !branding.wide || typeof html !== 'string' || !html.includes('<!--logo:')) return html;
  return html.replace(/<!--logo:([^>]*?)-->[\s\S]*?<!--\/logo-->/g, (_, base) =>
    `<img src="${logoUrl(branding, 'wide', base).replaceAll('&', '&amp;')}" alt="${groupName().replace(/"/g, '&quot;')}" style="display:block;border:0;max-width:${width}px;max-height:90px;width:auto;height:auto">`);
}
