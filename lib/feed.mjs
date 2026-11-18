// Each member's private calendar link: every meeting (with their RSVP) and
// their own open action items on their due dates.
import {groupName, meetingLink, rsvpLabels} from './email.mjs';
import {calendarFeed} from './schedule.mjs';

export async function feed(db, key, base, now = Date.now()) {
  if (!/^[a-f0-9]{40}$/.test(key ?? '')) return null;
  const member = await db.prepare("SELECT id FROM members WHERE feed=? AND status='active'").bind(key).first();
  if (!member) return null;
  const meetings = (await db.prepare(`SELECT m.*,r.status AS mine FROM meetings m LEFT JOIN rsvps r ON r.meeting=m.id AND r.member=?
    WHERE m.starts_at IS NOT NULL AND m.starts_at > ? ORDER BY m.starts_at`).bind(member.id, new Date(now - 90 * 86400000).toISOString()).all()).results;
  const actions = (await db.prepare(`SELECT a.id,a.title,a.due,mt.title AS meeting_title,mt.id AS meeting FROM actions a JOIN meetings mt ON mt.id=a.meeting
    WHERE a.owner=? AND a.status='open' AND a.due<>''`).bind(member.id).all()).results;
  const events = meetings.map(m => {
    const start = new Date(m.starts_at), link = meetingLink(base, m);
    return {uid: m.id + '@openfloor', start, end: new Date(start.getTime() + m.duration * 60000), title: m.title, location: m.location, url: link,
      description: (m.mine ? 'Your RSVP: ' + rsvpLabels[m.mine] : 'You haven’t RSVPed yet.') + '\nMeeting page: ' + link};
  });
  for (const a of actions) {
    events.push({uid: 'action-' + a.id + '@openfloor', date: a.due, title: 'Due: ' + a.title,
      description: 'Action item from ' + a.meeting_title + '\n' + meetingLink(base, {id: a.meeting})});
  }
  return calendarFeed(groupName(), events);
}
