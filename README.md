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

## Organizer panel and member preview

Organizers have an **Organizer** link in the top bar. It opens an overview of what needs attention: join requests, overdue and unassigned action items, events still needing helpers, and email problems. Below that are upcoming meetings with RSVP counts, a new-meeting form, quick links, downloads, and email health (sent today against the limit, waiting, retrying, failed, and when replies were last checked).

Member pages stay clean. On a meeting or event page, organizers see a slim bar with **Manage this meeting** (or event), which opens that item's own organizer page: attendance, topics with vote counts and moderation, the agenda builder, outcomes and action items, carry-over, and details.

**Preview as member** (top bar) shows every page exactly as a regular member sees it, with a banner to leave preview.

## Events and sign-ups

Any member can add an event (show, opening, workshop, workday, social) on the **Events** page. Events appear on the dashboard, in members' summaries and in everyone's calendar link. Organizers can also email everyone about an event straight away.

An event can have sign-up slots, like "Gallery sitting, Saturday 12–3" for 2 people. Members sign up or drop out on the site or with one tap from an email; slots can't be overfilled. Volunteers get a reminder the day before their slot, and their sign-ups show on their dashboard and calendar. Organizers can **Ask for help**, which emails members who haven't signed up yet, listing the open slots. The person who added an event and organizers can edit it and manage its slots. Each event has a discussion, and replying to an event email adds to it.

## Follow-through

**Action items.** Under a meeting's outcomes, organizers add action items with what needs doing, who owns it, and a due date. The owner gets an email. They can mark it done on the site, with the email's *Mark done* button, or by replying "done" (anything else they write goes to the meeting's discussion). Members see their open items on the dashboard. Reminders go out two days before, on the due date, and once when overdue. The *Email outcomes* button includes the action items, and the agenda builder can add a "Review open action items" item.

**Carry-over.** Topics that didn't make a meeting's agenda move to the next meeting: automatically when a repeating meeting creates the next one, or with *Move unused topics* on the organizer panel. They keep their author and show as "Carried over".

**Decisions.** The *Decisions* page lists past meetings with their agendas, decisions and action items, with a search box.

**Calendar.** Each member can get a private calendar link from the dashboard (Google, Apple or Outlook). It lists every meeting with their RSVP, and their own action items on their due dates, and updates on its own. Making a new link turns off the old one.

## Posts and replying by email

**Posts.** Any member can post an announcement or question from the dashboard, and others reply. Organizers can pin, hide or delete posts; authors can delete their own. Each meeting also has a discussion, and members can comment on topics.

**Email settings.** Each member chooses *Everything right away* (each post and reply as it happens), *Daily summary* (the default), *Weekly summary* (Mondays), or *Off*. Meeting invitations, agendas and reminders always come right away unless email is off.

**Replying by email.** Every email carries a personal reply address on the group Gmail, like `towerpressartistgroup+k1a2b…@gmail.com`; Gmail delivers these to the normal inbox. The site reads the inbox (over IMAP, with the same app password) and turns each reply into:

| Reply to | Starts with | Becomes |
| --- | --- | --- |
| A meeting email | `yes`, `going` | RSVP Going |
| | `maybe …` | RSVP Maybe (the rest is the reason) |
| | `no, because …`, `can't make it …` | RSVP Can't make it, with the reason |
| | `new topic: …` | A new topic (lines below are the details) |
| | anything else | A comment in the meeting's discussion |
| A topic (via its Reply link) | `+1` / `-1` | A vote (any text below is also posted as a comment) |
| A post or a reply | anything | A reply in that conversation |

Quoted text, signatures and "Sent from my iPhone" are removed. A reply only counts if it comes from the member's own address and Gmail verified the sender (DMARC, DKIM or SPF); automatic replies are ignored.

The inbox is read when someone opens the site, by a GitHub Action every 10 minutes (`.github/workflows/inbox.yml`), and by the daily job; it is never read more than once every 4 minutes. Gmail IMAP must be on (it is by default). Set `INBOUND=off` to turn replying by email off.

**Export.** Organizers can download members, meetings with outcomes, and attendance as spreadsheet (CSV) files from the Members page.

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
