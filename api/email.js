import {databaseUrl, postgres} from '../lib/db.mjs';
import {links} from '../lib/links.mjs';

export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return new Response('Not configured', {status: 503});
    try { return await links(request, postgres(url)); }
    catch (error) {
      console.error('Email link failed', error.code ?? error.name);
      return new Response('Something went wrong. Try again.', {status: 500, headers: {'Cache-Control': 'no-store'}});
    }
  }
};
