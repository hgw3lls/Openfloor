import {waitUntil} from '@vercel/functions';
import {databaseUrl, postgres} from '../lib/db.mjs';
import {createMailer} from '../lib/email.mjs';
import {posts} from '../lib/posts.mjs';

export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return Response.json({error: 'Not configured.'}, {status: 503});
    try { return await posts(request, postgres(url), createMailer(), waitUntil); }
    catch (error) {
      console.error('Posts request failed', error.code ?? error.name);
      return Response.json({error: 'Something went wrong. Try again.'}, {status: 500, headers: {'Cache-Control': 'no-store'}});
    }
  }
};
