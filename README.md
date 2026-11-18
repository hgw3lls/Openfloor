# Open Floor on Vercel

Open Floor lets artists submit topics, optionally vote for up to two, and see the agenda and meeting outcomes from one participant link.

## Deploy

1. Put the contents of this folder in a Git repository and import it to Vercel, with this folder as the project root. Use the **Other** framework preset.
2. Connect a Neon Postgres database from the Vercel Marketplace (Storage → Create Database → Neon) and link it to this project. The integration sets `DATABASE_URL` for you. If you use Preview deployments, point them at a separate Neon branch.
3. In Vercel, set `ORGANIZER_KEY` to a strong random value (for example, generate one with `openssl rand -hex 32`) for Production.
4. Deploy or redeploy after setting the variables. The build runs `scripts/migrate.mjs`, which creates the tables from `db/schema.sql` automatically (it is safe to run on every deploy). You can also run it by hand with `DATABASE_URL=... npm run migrate`. For participants to join without an account, the production deployment must allow visitors without Vercel Authentication.

## Run a meeting

Enter the organizer key to create a meeting. Bookmark the organizer URL and use **Copy participant link** to invite the group. The organizer URL grants editing access to that meeting. The participant link grants access to its topics, voting, agenda, and outcomes. Votes are limited to two topics per browser cookie.

You can open voting after collecting topics, or publish an agenda directly. Add deadlines or underrepresented topics manually and reorder the items before publishing. Use **Meeting outcomes** to record decisions and who will follow up.

The Vercel deployment uses its own database and generates new meeting links. The previous deployment's records are not imported automatically.
