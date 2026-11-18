import {databaseUrl, postgres} from '../lib/db.mjs';
import {checkReplies} from '../lib/inbox-run.mjs';

// Public on purpose: a scheduled GitHub Action pings it every few minutes.
// It reads the inbox at most every 4 minutes, so pinging more does nothing.
export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return Response.json({error: 'Not configured.'}, {status: 503});
    try {
      const report = await checkReplies(postgres(url), {request});
      return Response.json({read: report.read ?? 0, skipped: report.skipped ?? null}, {headers: {'Cache-Control': 'no-store'}});
    } catch (error) {
      console.error('Inbox check failed', error.code ?? error.name);
      return Response.json({error: 'Inbox check failed.'}, {status: 500});
    }
  }
};
