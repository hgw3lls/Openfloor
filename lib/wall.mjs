// What the member home screen ("the wall") needs beyond the dashboard:
// topics waiting for my vote, every upcoming sign-up slot, and open calls.
import {formatWhen} from './schedule.mjs';

const label = r => r.name || r.email.split('@')[0];

export async function wallData(db, me, level, now = Date.now()) {
  const run = (sql, ...args) => db.prepare(sql).bind(...args);
  const nowIso = new Date(now).toISOString();
  const out = {topics: [], slots: []};
  if (level('topics') === 'full') {
    out.topics = (await run(`SELECT t.id,t.label,t.detail,t.kind,m.id AS meeting,m.title AS meeting_title,m.starts_at,m.timezone FROM topics t JOIN meetings m ON m.id=t.meeting
      WHERE t.hidden=false AND m.phase<>'agenda' AND (m.starts_at IS NULL OR m.starts_at > ?) AND COALESCE(t.author,'')<>?
        AND NOT EXISTS (SELECT 1 FROM ballots b WHERE b.topic=t.id AND b.voter=?)
      ORDER BY m.starts_at NULLS LAST, t.created LIMIT 20`, nowIso, 'm:' + me.id, 'm:' + me.id).all()).results
      .map(t => ({id: t.id, label: t.label, detail: t.detail, kind: t.kind, meeting: t.meeting, meetingTitle: t.meeting_title,
        when: t.starts_at ? formatWhen(new Date(t.starts_at), t.timezone) : ''}));
  }
  if (level('events') !== 'off' && level('signups') !== 'off') {
    const slots = (await run(`SELECT s.id,s.label,s.starts_at,s.capacity,e.id AS event,e.title,e.starts_at AS event_start,e.timezone FROM slots s JOIN events e ON e.id=s.event
      WHERE e.hidden=false AND e.starts_at + make_interval(mins => e.duration) > ? ORDER BY COALESCE(s.starts_at, e.starts_at), s.position LIMIT 60`, nowIso).all()).results;
    const claims = slots.length ? (await run(`SELECT c.slot,c.member,m.name,m.email FROM claims c JOIN members m ON m.id=c.member JOIN slots s ON s.id=c.slot JOIN events e ON e.id=s.event
      WHERE e.hidden=false AND e.starts_at + make_interval(mins => e.duration) > ? AND m.status='active' ORDER BY c.created`, nowIso).all()).results : [];
    out.slots = slots.map(s => {
      const people = claims.filter(c => c.slot === s.id);
      const at = new Date(s.starts_at ?? s.event_start);
      return {id: s.id, label: s.label, event: s.event, eventTitle: s.title, startsAt: at.toISOString(), timed: !!s.starts_at,
        when: formatWhen(at, s.timezone), capacity: s.capacity, people: people.map(label), mine: people.some(p => p.member === me.id)};
    });
  }
  return out;
}
