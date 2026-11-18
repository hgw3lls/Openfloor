import {databaseUrl, postgres} from '../lib/db.mjs';
import {appBase, createMailer} from '../lib/email.mjs';
import {daily} from '../lib/cron.mjs';

// Called once a day by Vercel Cron (see vercel.json). Vercel sends
// "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set.
export default {
  async fetch(request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get('Authorization') !== 'Bearer ' + secret) return new Response('Unauthorized', {status: 401});
    const url = databaseUrl();
    if (!url) return Response.json({error: 'Not configured'}, {status: 503});
    try { return Response.json(await daily(postgres(url), createMailer(), appBase())); }
    catch (error) {
      console.error('Daily job failed', error.code ?? error.name);
      return Response.json({error: 'Failed'}, {status: 500});
    }
  }
};
