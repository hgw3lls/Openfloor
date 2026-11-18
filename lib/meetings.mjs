import {timingSafeEqual} from 'node:crypto';

const json = (data, status = 200) => Response.json(data, {status, headers:{'Cache-Control':'no-store'}});
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0,length) : '';
const key = value => /^[a-f0-9-]{36}$/.test(value ?? '');
function voter(request) {
  const cookie = request.headers.get('Cookie')?.match(/(?:^|; )floor=([a-f0-9-]{36})(?:;|$)/)?.[1];
  return cookie || crypto.randomUUID();
}

export async function meetings(request, db, organizerKey) {
  const url = new URL(request.url);
  const id = url.searchParams.get('meeting') || '';
  const action = url.searchParams.get('action') || '';
  const run = (sql, ...args) => db.prepare(sql).bind(...args);
  const write = request.method === 'POST';
  if (write && (request.headers.get('Origin') !== url.origin ||
      !request.headers.get('Content-Type')?.startsWith('application/json'))) return json({error:'Invalid request.'},403);
  let input = {};
  if (write) {
    const raw = await request.text();
    if (raw.length > 22000) return json({error:'This entry is too long.'},413);
    try { input = JSON.parse(raw) ?? {}; } catch { return json({error:'Invalid entry.'},400); }
  } else if (request.method !== 'GET') return json({error:'Method unavailable.'},405);

  if (!id && !action && write) {
    const supplied = Buffer.from(clean(input.organizerKey, 256));
    const expected = Buffer.from(organizerKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) {
      return json({error:'Enter the organizer access key to create a meeting.'},403);
    }
    const title = clean(input.title,100);
    if (!title) return json({error:'Enter a meeting name.'},400);
    const meeting = crypto.randomUUID(), secret = crypto.randomUUID();
    await run('INSERT INTO meetings (id,secret,title,schedule) VALUES (?,?,?,?)',meeting,secret,title,clean(input.schedule,120)).run();
    return json({id:meeting,secret},201);
  }
  if (!key(id)) return json({error:'Meeting not found.'},404);
  const meeting = await run('SELECT * FROM meetings WHERE id=?',id).first();
  if (!meeting) return json({error:'Meeting not found.'},404);
  const admin = request.headers.get('Authorization') === 'Bearer '+meeting.secret;
  const person = voter(request);
  const phase = meeting.phase;

  if (!write) {
    const list = await run(`SELECT t.id,t.label,t.detail,t.kind,
      (SELECT COUNT(*)::integer FROM votes WHERE meeting=t.meeting AND (pick1=t.id OR pick2=t.id)) AS votes
      FROM topics t WHERE t.meeting=? ORDER BY votes DESC,t.created ASC`,id).all();
    const picks = await run('SELECT pick1,pick2 FROM votes WHERE meeting=? AND voter=?',id,person).first();
    const response = json({id,title:meeting.title,schedule:meeting.schedule,phase,admin,topics:list.results,
      picks:[picks?.pick1,picks?.pick2].filter(Boolean),agenda:JSON.parse(meeting.agenda),notes:meeting.notes});
    response.headers.append('Set-Cookie','floor='+person+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000');
    return response;
  }
  if (action==='topic') {
    const label=clean(input.label,120);
    if (!label) return json({error:'Enter a topic.'},400);
    const kind = ['Discussion','Decision','Update'].includes(input.kind) ? input.kind : 'Discussion';
    const result = await run(`INSERT INTO topics (id,meeting,label,detail,kind,created) SELECT ?,id,?,?,?,? FROM meetings WHERE id=? AND phase='collect'`,
      crypto.randomUUID(),label,clean(input.detail,650),kind,Date.now(),id).run();
    if (!result.meta.changes) return json({error:'Topic submissions are closed.'},409);
  } else if (action==='vote') {
    if (!Array.isArray(input.picks) || input.picks.length>2 || !input.picks.every(key) ||
        new Set(input.picks).size!==input.picks.length) return json({error:'Choose up to two topics.'},400);
    const [a='',b='']=input.picks;
    const result=await run(`INSERT INTO votes (meeting,voter,pick1,pick2) SELECT id,?,?,? FROM meetings WHERE id=? AND phase='vote'
      AND (?::text='' OR EXISTS(SELECT 1 FROM topics WHERE id=? AND meeting=meetings.id))
      AND (?::text='' OR EXISTS(SELECT 1 FROM topics WHERE id=? AND meeting=meetings.id))
      ON CONFLICT(meeting,voter) DO UPDATE SET pick1=excluded.pick1,pick2=excluded.pick2`,person,a,b,id,a,a,b,b).run();
    if (!result.meta.changes) return json({error:'Voting is closed or a topic is unavailable.'},409);
  } else if (admin && action==='phase') {
    if (!['collect','vote'].includes(input.phase)) return json({error:'Invalid phase.'},400);
    await run('UPDATE meetings SET phase=? WHERE id=?',input.phase,id).run();
  } else if (admin && action==='agenda') {
    const agenda = Array.isArray(input.agenda) ? input.agenda.slice(0,15).map(item=>({
      label:clean(item?.label,120),detail:clean(item?.detail,650),
      kind:['Discussion','Decision','Update'].includes(item?.kind)?item.kind:'Discussion',
      minutes:Math.max(1,Math.min(120,Number.parseInt(item?.minutes,10)||10))
    })).filter(item=>item.label) : [];
    if (!agenda.length) return json({error:'Add at least one agenda item.'},400);
    await run("UPDATE meetings SET agenda=?,phase='agenda' WHERE id=?",JSON.stringify(agenda),id).run();
  } else if (admin && action==='notes') {
    await run('UPDATE meetings SET notes=? WHERE id=?',clean(input.notes,7000),id).run();
  } else return json({error:'This action is unavailable.'},403);
  return json({ok:true});
}

