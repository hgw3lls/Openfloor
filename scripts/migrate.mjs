// Applies db/schema.sql to the Neon database. Runs automatically during the
// Vercel build (npm run build). Every statement uses IF NOT EXISTS, so it is
// safe to run on every deploy.
import {readFile} from 'node:fs/promises';
import {neon} from "@neondatabase/serverless";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.warn('migrate: DATABASE_URL is not set; skipping schema setup.');
  process.exit(0);
}

const sql = neon(url);
const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
const statements = schema.split(';').map(s => s.trim()).filter(Boolean);
for (const statement of statements) await sql.query(statement);
console.log(`migrate: applied ${statements.length} schema statements.`);
