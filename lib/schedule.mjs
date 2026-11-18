// Time zone helpers, calendar files and calendar links. No dependencies:
// Node's built-in Intl data does the time zone math.

export function validZone(zone) {
  try { new Intl.DateTimeFormat('en-US', {timeZone: zone}); return true; } catch { return false; }
}

function parts(date, zone) {
  const list = new Intl.DateTimeFormat('en-US', {timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}).formatToParts(date);
  return Object.fromEntries(list.map(part => [part.type, part.value]));
}

function offset(date, zone) {
  const p = parts(date, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-12-03T19:00" in "Europe/Berlin" -> Date (UTC instant)
export function zonedToUtc(local, zone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? '');
  if (!match) return null;
  const [, y, m, d, h, min] = match.map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  let guess = wall - offset(new Date(wall), zone);
  guess = wall - offset(new Date(guess), zone);
  return new Date(guess);
}

// Date -> "2026-12-03T19:00" in zone (for <input type=datetime-local>)
export function localValue(date, zone) {
  const p = parts(date, zone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function formatWhen(date, zone) {
  return new Intl.DateTimeFormat('en-US', {timeZone: zone, weekday: 'long', month: 'long', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}).format(date);
}

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
function fold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line);
  return out.join('\r\n');
}

export function calendarFile(meeting, link) {
  const start = new Date(meeting.starts_at);
  const end = new Date(start.getTime() + meeting.duration * 60000);
  const agenda = JSON.parse(meeting.agenda || '[]').map((item, i) => `${i + 1}. ${item.label} (${item.minutes} min)`).join('\n');
  const description = (agenda ? 'Agenda:\n' + agenda + '\n\n' : '') + 'Meeting page: ' + link;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Open Floor//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', 'UID:' + meeting.id + '@openfloor', 'DTSTAMP:' + stamp(new Date()), 'DTSTART:' + stamp(start),
    'DTEND:' + stamp(end), 'SUMMARY:' + icsText(meeting.title), 'DESCRIPTION:' + icsText(description),
    meeting.location ? 'LOCATION:' + icsText(meeting.location) : '', 'URL:' + link, 'END:VEVENT', 'END:VCALENDAR']
    .filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

export function googleLink(meeting, link) {
  const start = new Date(meeting.starts_at);
  const end = new Date(start.getTime() + meeting.duration * 60000);
  const query = new URLSearchParams({action: 'TEMPLATE', text: meeting.title, dates: stamp(start) + '/' + stamp(end),
    details: 'Meeting page: ' + link, location: meeting.location || ''});
  return 'https://calendar.google.com/calendar/render?' + query;
}

// The next start of a repeating meeting, keeping the same local time (so a
// 7 pm meeting stays at 7 pm across daylight saving changes).
// repeat: 'weekly' | 'biweekly' | 'monthly' (same weekday of the month, e.g. 2nd Tuesday)
export function nextOccurrence(start, zone, repeat) {
  const [date, time] = localValue(start, zone).split('T');
  const [y, m, d] = date.split('-').map(Number);
  const pad = n => String(n).padStart(2, '0');
  let next;
  if (repeat === 'weekly' || repeat === 'biweekly') {
    next = new Date(Date.UTC(y, m - 1, d + (repeat === 'weekly' ? 7 : 14)));
  } else if (repeat === 'monthly') {
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(), nth = Math.ceil(d / 7);
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay(), days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let day = 1 + (weekday - first + 7) % 7 + (nth - 1) * 7;
    if (day > days) day -= 7; // a "5th Tuesday" becomes the last Tuesday
    next = new Date(Date.UTC(y, m, day));
  } else return null;
  return zonedToUtc(`${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T${time}`, zone);
}
