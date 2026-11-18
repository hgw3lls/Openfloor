import {databaseUrl, postgres} from '../lib/db.mjs';
import {createMailer} from '../lib/email.mjs';
import {meetings} from '../lib/meetings.mjs';

export default {
  async fetch(request) {
    const DATABASE_URL = databaseUrl(), {ORGANIZER_KEY} = process.env;
    if (!DATABASE_URL || !ORGANIZER_KEY?.trim()) {
      return Response.json({error:'The meeting board has not been configured yet.'}, {status:503});
    }
    try {
      return await meetings(request, postgres(DATABASE_URL), ORGANIZER_KEY.trim(), createMailer());
    } catch (error) {
      console.error('Meeting request failed', error.code ?? error.name);
      return Response.json({error:'Something went wrong. Try again.'}, {status:500, headers:{'Cache-Control':'no-store'}});
    }
  }
};
