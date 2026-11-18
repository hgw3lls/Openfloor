# Open Floor on Vercel

Open Floor lets artists submit topics, optionally vote for up to two, and see the agenda and meeting outcomes from one participant link.

## Deploy

1. Put the contents of this folder in a Git repository and import it to Vercel, with this folder as the project root. Use the **Other** framework preset.
2. Connect a Neon Postgres database from the Vercel Marketplace. Run `db/schema.sql` in the Neon SQL Editor for the database branch you will deploy to.
3. In Vercel, set `DATABASE_URL` to that branch's Neon connection string. Set `ORGANIZER_KEY` to a strong random value (for example, generate one with `openssl rand -hex 32`). Set both for Production, and configure a separate database branch if using Preview deployments.
4. Deploy or redeploy after setting the variables. For participants to join without an account, the production deployment must allow visitors without Vercel Authentication.

## Run a meeting

Enter the organizer key to create a meeting. Bookmark the organizer URL and use **Copy participant link** to invite the group. The organizer URL grants editing access to that meeting. The participant link grants access to its topics, voting, agenda, and outcomes. Votes are limited to two topics per browser cookie.

You can open voting after collecting topics, or publish an agenda directly. Add deadlines or underrepresented topics manually and reorder the items before publishing. Use **Meeting outcomes** to record decisions and who will follow up.

The Vercel deployment uses its own database and generates new meeting links. The previous deployment's records are not imported automatically.
