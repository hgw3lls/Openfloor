import {waitUntil} from '@vercel/functions';
import {databaseUrl, postgres} from '../lib/db.mjs';
import {createMailer} from '../lib/email.mjs';
import {events} from '../lib/events.mjs';

export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return Response.json({error: 'Not configured.'}, {status: 503});
    try { return await events(request, postgres(url), createMailer(), waitUntil); }
    catch (error) {
      console.error('Events request failed', error.code ?? error.name);
      return Response.json({error: 'Something went wrong. Try again.'}, {status: 500, headers: {'Cache-Control': 'no-store'}});
    }
  }
};
