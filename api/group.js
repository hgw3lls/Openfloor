import {waitUntil} from '@vercel/functions';
import {databaseUrl, postgres} from '../lib/db.mjs';
import {createMailer} from '../lib/email.mjs';
import {group} from '../lib/group.mjs';

export default {
  async fetch(request) {
    const DATABASE_URL = databaseUrl(), {ORGANIZER_KEY} = process.env;
    if (!DATABASE_URL || !ORGANIZER_KEY?.trim()) {
      return Response.json({error: 'The group has not been configured yet.'}, {status: 503});
    }
    try {
      return await group(request, postgres(DATABASE_URL), ORGANIZER_KEY.trim(), createMailer(), waitUntil);
    } catch (error) {
      console.error('Group request failed', error.code ?? error.name);
      return Response.json({error: 'Something went wrong. Try again.'}, {status: 500, headers: {'Cache-Control': 'no-store'}});
    }
  }
};
