// Reads email replies and sends anything they queued. Safe to call often:
// pollInbox only reads the inbox if it hasn't in the last 4 minutes.
import {emailActions} from './actions.mjs';
import {appBase, createMailer} from './email.mjs';
import {flush} from './outbox.mjs';
import {pollInbox} from './replies.mjs';

export async function checkReplies(db, {request, force = false} = {}) {
  const mailer = createMailer(), base = appBase(request);
  const report = await pollInbox(db, emailActions(db, {mailer, base}), {force});
  if (report.read) await flush(db, mailer);
  return report;
}
