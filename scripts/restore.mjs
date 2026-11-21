// Restores a weekly backup (the .json.gz attached to the backup email).
//   DATABASE_URL=... node scripts/restore.mjs tower-press-backup-2026-11-22.json.gz
// Best into a fresh, empty database (a new Neon branch works well): it sets up
// the tables first, then adds every row. Use --force to restore into a
// database that already has members; existing rows are left alone.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {databaseUrl, postgres} from '../lib/db.mjs';
import {restoreData} from '../lib/backup.mjs';

const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const url = databaseUrl();
if (!file || !url) { console.error('Usage: DATABASE_URL=... node scripts/restore.mjs backup.json.gz [--force]'); process.exit(1); }
const raw = readFileSync(file);
const data = JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
const db = postgres(url);
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8').split(';').map(s => s.trim()).filter(Boolean);
for (const s of schema) await db.prepare(s).bind().run();
const {n} = await db.prepare('SELECT COUNT(*)::integer AS n FROM members').bind().first();
if (n && !process.argv.includes('--force')) { console.error(`This database already has ${n} members. Use --force to add the backup anyway.`); process.exit(1); }
console.log(`Restoring the backup from ${data.created}…`);
console.table(await restoreData(db, data));
console.log('Done. Members sign in again by email: their old email links no longer work.');
