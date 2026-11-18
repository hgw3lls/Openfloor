# Open Floor on Vercel

Open Floor lets artists submit topics, optionally vote for up to two, and see the agenda and meeting outcomes from one participant link.

## Deploy

1. Put the contents of this folder in a Git repository and import it to Vercel, with this folder as the project root. Use the **Other** framework preset.
2. Connect a Neon Postgres database from the Vercel Marketplace (Storage → Create Database → Neon) and link it to this project. The integration sets `DATABASE_URL` for you. If you use Preview deployments, point them at a separate Neon branch.
3. In Vercel, set `ORGANIZER_KEY` to a strong random value (for example, generate one with `openssl rand -hex 32`) for Production.
4. Deploy or redeploy after setting the variables. The build runs `scripts/migrate.mjs`, which creates the tables from `db/schema.sql` automatically (it is safe to run on every deploy). You can also run it by hand with `DATABASE_URL=... npm run migrate`. For participants to join without an account, the production deployment must allow visitors without Vercel Authentication.

## Run the group

**First time:** open the site and use **Set up the group** with the organizer key (`ORGANIZER_KEY`) to become the first organizer. You're signed in on that device. The key can sign an organizer in again later if they lose access.

**Members.** Organizers add people on the **Members** page (one per line, `Name <email>`). Each person gets an invitation to accept, so nobody is added without agreeing. People can also ask to join from the front page; organizers approve them, and they get a welcome email. Members sign in with a link sent by email, with no passwords, and stay signed in for a year. Organizers can make other members organizers.

**Meetings.** Organizers create meetings from the dashboard: name, date and time, time zone, length, place, and whether the meeting repeats weekly, every two weeks or monthly (same weekday). Every member gets an email with RSVP buttons. Repeating meetings create the next one automatically after each meeting ends.

**RSVP.** Members answer Going, Maybe or Can't make it, on the site or with one tap from email. Declining needs a reason, which only organizers see. Organizers see who's coming, who declined and why, and who hasn't answered, and can email a reminder to people who haven't answered.

**Topics and voting.** Members suggest topics and vote 👍 or 👎 until the agenda is published, one vote each and never on their own topics. Votes from email count as the same person as votes on the site. Organizers can edit, hide or delete any topic, build the agenda from the top topics, publish it (members get it by email with calendar links), and record and email the outcomes.

## Email updates

Members get these emails unless they turn email off in their settings or with the unsubscribe link (they stay members):

- **A daily digest of new topics**, with 👍 / 👎 buttons on each one. Tapping a button opens a page where one more tap saves the vote. That extra tap stops email security scanners, which open links automatically, from casting votes.
- **"Vote on the topics"**, when the organizer closes submissions.
- **The agenda**, with *Add to calendar* and *Google Calendar* links, when it's first published. The organizer can resend it.
- **New meeting** with RSVP buttons, and **Time changed** when the organizer moves it.
- **A reminder** about a day before the meeting.
- **The outcomes**, when the organizer clicks *Email outcomes*.

Every email has an unsubscribe link and the one-click unsubscribe header that Gmail and Yahoo require.

### Setup with Gmail (no domain needed)

1. On the Google account you'll send from, turn on [2-Step Verification](https://myaccount.google.com/signinoptions/twosv).
2. Create an [app password](https://myaccount.google.com/apppasswords) named "Open Floor" and copy the 16-character password.
3. In Vercel, set these environment variables for Production, then redeploy:
   - `SMTP_USER`: the Gmail address.
   - `SMTP_PASS`: the app password (spaces are fine).
   - `CRON_SECRET`: a long random value. Vercel uses it to call the daily email job.
   - `APP_URL`: the public address, for example `https://tower-press-org.vercel.app`, used for links in the daily emails.
   - `EMAIL_FROM` (optional): defaults to `Open Floor <your Gmail address>`.
   - `EMAIL_REPLY_TO` (optional): where replies to the emails go.

Gmail allows about 500 emails a day, which is plenty for a group. To send from your own domain instead, set `RESEND_API_KEY` and `EMAIL_FROM` (an address on a domain verified in [Resend](https://resend.com)) and leave `SMTP_USER`/`SMTP_PASS` unset. Any other SMTP server also works with `SMTP_HOST` and `SMTP_PORT`.

The daily job runs at 16:00 UTC (see `vercel.json`).

Emails are queued and sent in the background, so nobody waits on Gmail. Failed sends are retried (up to 5 attempts). To stay under Gmail's limit, at most `EMAIL_DAILY_LIMIT` emails (default 400) go out in any 24 hours; anything over that waits for the next run instead of being dropped. Email sign-ups are rate-limited and have a hidden spam trap.

## Development

```sh
npm install
npm test
```

The tests run against an in-memory Postgres (PGlite) and a local mail server, so they need no accounts or network. They also run automatically on every pull request.
