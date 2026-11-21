import {waitUntil} from '@vercel/functions';
import {databaseUrl, postgres} from '../lib/db.mjs';
import {createMailer} from '../lib/email.mjs';
import {links} from '../lib/links.mjs';
import {flush} from '../lib/outbox.mjs';

export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return new Response('Not configured', {status: 503});
    try {
      const db = postgres(url), mailer = createMailer();
      const response = await links(request, db, Date.now(), mailer);
      // Taps that change something (POST) may have queued a welcome email.
      if (mailer && request.method === 'POST') waitUntil(flush(db, mailer).catch(error => console.error('Outbox flush failed', error.code ?? error.name)));
      return response;
    } catch (error) {
      console.error('Email link failed', error.code ?? error.name);
      return new Response('Something went wrong. Try again.', {status: 500, headers: {'Cache-Control': 'no-store'}});
    }
  }
};
