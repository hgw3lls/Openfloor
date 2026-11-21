# Handoff: Tower Press members app

Written 21 Nov 2026, when work moved from the cloud session to a local machine.

The unfinished work is pushed to `claude/tower-press-neon-setup-m6u1ei`. Compared with `main`, the branch changes only `lib/group.mjs` and `test/security.test.mjs`. There's no PR for it yet.

## Getting set up locally

```
git clone https://github.com/hgw3lls/Openfloor && cd Openfloor
git checkout claude/tower-press-neon-setup-m6u1ei
npm install
npm test
```

`npm test` uses an in-memory database, so it needs no setup. To get the live environment variables, run `vercel link`, then `vercel env pull`.

## What's live

https://tower-press-org.vercel.app is up to date with `main`, through PR #26. Recent merges:

- **PR #25, security and reliability fixes:**
  - atomic rate limits;
  - safe resending of queued email;
  - email links follow the same rules as the site;
  - the join form no longer activates invited members;
  - links from other sites can't sign anyone in;
  - removed members' volunteer places are freed;
  - only Gmail's own sender check is trusted;
  - the remaining smaller fixes from the review.
- **PR #26, weekly backup:**
  - it emails the group inbox every Sunday at about 16:00 UTC;
  - organizers have a **Full backup** button;
  - `scripts/restore.mjs` restores a backup.
- **The organizer key** was changed in Vercel and production was redeployed. The new key was sent as a separate file. Store it in a password manager.

## Unfinished: item 6, the two clean-ups

- **When someone is removed** (in `lib/group.mjs`, the `remove` action), their call interest and call checklist ticks are deleted too, along with their votes on proposals still open. Votes on decided proposals are kept.
- **The join form** gives the same reply for everyone, whether the address is a member, invited, removed or new.
- **Tests:** two new tests at the end of `test/security.test.mjs` both pass, and that whole file passes (21 of 21).
- **Not checked yet:** the full `npm test` was interrupted, so the full suite hasn't been run on these changes. I also didn't confirm the two new tests fail on the old code.
- **Next:** run `npm test`, then open a PR and merge.

## Item 4: separate database for previews (needs you)

The Vercel token can't open Storage settings; it gets a "forbidden" error. To turn this on yourself:

1. In Vercel, go to the project, then **Storage**, then the Neon database, then **Settings**.
2. Under the deployment settings, turn on database branching for **Preview** deployments.

After that, each preview gets its own copy of the database, and testing a preview no longer changes live data. Preview deploys already send no email, because the email settings exist only for production.

## Still open

- Clearer reply instructions in the emails: say what you can type (yes / maybe / no, "new topic:", +1 / -1, done). The wording is in `lib/email.mjs`.
- Check that the first backup email arrives on Sunday with its file attached.
- Optional:
  - a welcome message for members;
  - your own web address;
  - sending email from your own domain through Resend (the code already supports it; it needs `RESEND_API_KEY` and `EMAIL_FROM`).

## Useful to know

- **Hosting and email:**
  - The daily job is at `/api/cron` and needs `CRON_SECRET`.
  - **The inbox check (email replies):** a free [cron-job.org](https://console.cron-job.org) job, "Tower Press: check email replies", sends a `POST` to `/api/inbox` every 5 minutes. It emails the account owner after 3 failures in a row. If that account or job goes away, replies still arrive, just slowly: the GitHub Action (`.github/workflows/inbox.yml`) is a backup but in practice GitHub runs it only every few hours, and the site also checks when someone opens it.
  - Email goes through Gmail, up to 400 a day (`EMAIL_DAILY_LIMIT`).
- **Database schema:** `db/schema.sql` is applied on every build. Only add to it; never change or remove what's there.
- **Database queries:** all of them use `?` placeholders through `db.prepare(...).bind(...)`.
