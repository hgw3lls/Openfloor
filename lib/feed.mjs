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
  const happenings = (await db.prepare(`SELECT * FROM events WHERE hidden=false AND starts_at > ? ORDER BY starts_at`).bind(new Date(now - 90 * 86400000).toISOString()).all()).results;
  for (const e of happenings) {
    const start = new Date(e.starts_at), link = base + '/#event/' + e.id;
    events.push({uid: 'event-' + e.id + '@openfloor', start, end: new Date(start.getTime() + e.duration * 60000), title: e.kind === 'Event' ? e.title : e.kind + ': ' + e.title,
      location: e.location, url: link, description: (e.description ? e.description + '\n\n' : '') + link});
  }
  const shifts = (await db.prepare(`SELECT s.id,s.label,s.starts_at,s.duration,e.id AS event,e.title,e.location FROM claims c JOIN slots s ON s.id=c.slot JOIN events e ON e.id=s.event
    WHERE c.member=? AND e.hidden=false AND s.starts_at IS NOT NULL`).bind(member.id).all()).results;
  for (const s of shifts) {
    const start = new Date(s.starts_at);
    events.push({uid: 'slot-' + s.id + '-' + member.id + '@openfloor', start, end: new Date(start.getTime() + (s.duration || 60) * 60000),
      title: 'You: ' + s.label, location: s.location, description: 'You signed up for this at ' + s.title + '\n' + base + '/#event/' + s.event});
  }
  const deadlines = (await db.prepare(`SELECT c.id,c.title,c.deadline,c.kind,i.status FROM call_interest i JOIN calls c ON c.id=i.call
    WHERE i.member=? AND c.hidden=false AND i.status IN ('interested','applying')`).bind(member.id).all()).results;
  for (const c of deadlines) {
    events.push({uid: 'call-' + c.id + '-' + member.id + '@openfloor', date: c.deadline, title: 'Deadline: ' + c.title,
      description: c.kind + ' · you’re ' + c.status + '\n' + base + '/#call/' + c.id});
  }
  for (const a of actions) {
    events.push({uid: 'action-' + a.id + '@openfloor', date: a.due, title: 'Due: ' + a.title,
      description: 'Action item from ' + a.meeting_title + '\n' + meetingLink(base, {id: a.meeting})});
  }
  return calendarFeed(groupName(), events);
}
