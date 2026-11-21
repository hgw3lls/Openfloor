// Spreadsheet (CSV) downloads for organizers: members, meetings, attendance.
import {currentMember} from './auth.mjs';
import {formatWhen} from './schedule.mjs';

// Quotes every cell, and stops spreadsheet apps from running a cell as a formula.
export function csv(rows) {
  const cell = value => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export async function exportData(request, db) {
  const me = await currentMember(request, db);
  if (me?.role !== 'organizer') return Response.json({error: 'Only organizers can export.'}, {status: 403});
  const what = new URL(request.url).searchParams.get('what');
  if (what === 'backup') {
    const {backupData} = await import('./backup.mjs');
    return new Response(JSON.stringify(await backupData(db)), {headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="tower-press-backup-${new Date().toISOString().slice(0, 10)}.json"`}});
  }
  const run = sql => db.prepare(sql).bind().all().then(r => r.results);
  const when = m => m.starts_at ? formatWhen(new Date(m.starts_at), m.timezone) : m.schedule;
  let rows;
  if (what === 'members') {
    rows = [['Name', 'Email', 'Role', 'Status', 'Email setting'],
      ...(await run("SELECT name,email,role,status,emails,digest FROM members WHERE status<>'removed' ORDER BY lower(name),email"))
        .map(m => [m.name, m.email, m.role, m.status, m.emails === 'none' ? 'off' : m.digest])];
  } else if (what === 'meetings') {
    rows = [['Meeting', 'When', 'Place', 'Stage', 'Agenda', 'Decisions and next steps'],
      ...(await run('SELECT * FROM meetings ORDER BY starts_at DESC NULLS LAST, created DESC')).map(m => [m.title, when(m), m.location, m.phase,
        JSON.parse(m.agenda || '[]').map((a, i) => `${i + 1}. ${a.label} (${a.minutes} min)`).join('\n'), m.notes])];
  } else if (what === 'attendance') {
    rows = [['Meeting', 'When', 'Member', 'Email', 'RSVP', 'Reason'],
      ...(await run(`SELECT mt.title,mt.starts_at,mt.timezone,mt.schedule,m.name,m.email,r.status,r.reason FROM rsvps r
        JOIN meetings mt ON mt.id=r.meeting JOIN members m ON m.id=r.member ORDER BY mt.starts_at DESC NULLS LAST, lower(m.name)`))
        .map(r => [r.title, when(r), r.name, r.email, {yes: 'Going', maybe: 'Maybe', no: "Can't make it"}[r.status], r.reason])];
  } else return Response.json({error: 'Choose members, meetings or attendance.'}, {status: 400});
  return new Response(csv(rows), {headers: {'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="tower-press-${what}-${new Date().toISOString().slice(0, 10)}.csv"`}});
}
