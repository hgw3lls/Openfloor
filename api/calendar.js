import {databaseUrl, postgres} from '../lib/db.mjs';
import {appBase, meetingLink} from '../lib/email.mjs';
import {calendarFile} from '../lib/schedule.mjs';

export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return new Response('Not configured', {status: 503});
    const id = new URL(request.url).searchParams.get('meeting') || '';
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
