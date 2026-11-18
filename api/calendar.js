import {databaseUrl, postgres} from '../lib/db.mjs';
import {appBase, meetingLink} from '../lib/email.mjs';
import {calendarFile} from '../lib/schedule.mjs';
import {feed} from '../lib/feed.mjs';

export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return new Response('Not configured', {status: 503});
    const params = new URL(request.url).searchParams;
    if (params.has('feed')) {
      try {
        const body = await feed(postgres(url), params.get('feed'), appBase(request));
        if (!body) return new Response('Calendar link not found. Get a new one from the site.', {status: 404});
        return new Response(body, {headers: {'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'}});
      } catch (error) { console.error('Feed failed', error.code ?? error.name); return new Response('Something went wrong.', {status: 500}); }
    }
    const id = params.get('meeting') || '';
    if (!/^[a-f0-9-]{36}$/.test(id)) return new Response('Not found', {status: 404});
    try {
      const meeting = await postgres(url).prepare('SELECT * FROM meetings WHERE id=?').bind(id).first();
      if (!meeting?.starts_at) return new Response('This meeting has no date yet.', {status: 404});
      return new Response(calendarFile(meeting, meetingLink(appBase(request), meeting)), {headers: {
        'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="meeting.ics"', 'Cache-Control': 'no-store'}});
    } catch (error) {
      console.error('Calendar failed', error.code ?? error.name);
      return new Response('Something went wrong.', {status: 500});
    }
  }
};
