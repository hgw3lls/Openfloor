import {timingSafeEqual} from 'node:crypto';
import {agendaEmail, appBase, outcomesEmail, topicsEmail} from './email.mjs';
import {emailPattern, markSent, notify, subscribe} from './notify.mjs';
import {formatWhen, localValue, validZone, zonedToUtc} from './schedule.mjs';

const json = (data, status = 200) => Response.json(data, {status, headers:{'Cache-Control':'no-store'}});
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0,length) : '';
const key = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const kinds = ['Discussion','Decision','Update'];
function voter(request) {
  const cookie = request.headers.get('Cookie')?.match(/(?:^|; )floor=([a-f0-9-]{36})(?:;|$)/)?.[1];
  return cookie || crypto.randomUUID();
}

// Sends to the list without failing the organizer's action if email is down.
async function deliver(task) {
  try { const count = await task(); return count ? `Emailed ${count} ${count === 1 ? 'person' : 'people'}.` : ''; }
  catch (error) { console.error('Email failed', error.code ?? error.name); return 'Saved, but the email could not be sent.'; }
}

export async function meetings(request, db, organizerKey, mailer = null) {
  const url = new URL(request.url);
  const base = appBase(request);
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
  const ballotId = 'c:' + person;
  const phase = meeting.phase;
  const sent = JSON.parse(meeting.sent || '{}');

  if (!write) {
    const list = (await run(`SELECT t.id,t.label,t.detail,t.kind,
      COUNT(*) FILTER (WHERE b.value>0)::integer AS up,
      COUNT(*) FILTER (WHERE b.value<0)::integer AS down,
      COALESCE(MAX(b.value) FILTER (WHERE b.voter=?),0)::integer AS mine
      FROM topics t LEFT JOIN ballots b ON b.topic=t.id WHERE t.meeting=?
      GROUP BY t.id ORDER BY COALESCE(SUM(b.value),0) DESC, t.created ASC`,ballotId,id).all()).results;
    const showCounts = admin || phase === 'agenda';
    const topics = list.map(t => ({...t, votes:t.up-t.down, ...(showCounts ? {} : {up:null,down:null,votes:null})}));
    const start = meeting.starts_at ? new Date(meeting.starts_at) : null;
    const data = {id,title:meeting.title,schedule:meeting.schedule,phase,admin,topics,
      agenda:JSON.parse(meeting.agenda),notes:meeting.notes,emailEnabled:!!mailer,appUrl:base,
      startsAt:start?.toISOString() ?? null,timezone:meeting.timezone,duration:meeting.duration,location:meeting.location,
      when:start ? formatWhen(start,meeting.timezone) : '',local:start ? localValue(start,meeting.timezone) : ''};
    if (admin) {
      data.subscribers = (await run('SELECT email,status FROM subscribers WHERE meeting=? ORDER BY email',id).all()).results;
      data.sent = sent;
    }
    const response = json(data);
    response.headers.append('Set-Cookie','floor='+person+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000');
    return response;
  }

  if (action==='topic') {
    const label=clean(input.label,120);
    if (!label) return json({error:'Enter a topic.'},400);
    const kind = kinds.includes(input.kind) ? input.kind : 'Discussion';
    const result = await run(`INSERT INTO topics (id,meeting,label,detail,kind,created,announced) SELECT ?,id,?,?,?,?,false FROM meetings WHERE id=? AND phase='collect'`,
      crypto.randomUUID(),label,clean(input.detail,650),kind,Date.now(),id).run();
    if (!result.meta.changes) return json({error:'Topic submissions are closed.'},409);
  } else if (action==='vote') {
    const value = Number(input.value);
    if (!key(input.topic) || ![1,0,-1].includes(value)) return json({error:'Invalid vote.'},400);
    if (phase === 'agenda') return json({error:'Voting is closed.'},409);
    const topic = await run('SELECT id FROM topics WHERE id=? AND meeting=?',input.topic,id).first();
    if (!topic) return json({error:'That topic is unavailable.'},409);
    if (value === 0) await run('DELETE FROM ballots WHERE topic=? AND voter=?',input.topic,ballotId).run();
    else await run(`INSERT INTO ballots (topic,meeting,voter,value) VALUES (?,?,?,?)
      ON CONFLICT (topic,voter) DO UPDATE SET value=excluded.value`,input.topic,id,ballotId,value).run();
  } else if (action==='subscribe') {
    if (!mailer) return json({error:'Email updates are not set up yet.'},409);
    const email = clean(input.email,254).toLowerCase();
    if (!emailPattern.test(email)) return json({error:'Enter a valid email address.'},400);
    const state = await subscribe(db,mailer,base,meeting,email);
    return json({ok:true,notice:state==='active' ? 'You are already getting updates.' : 'Check your inbox to confirm.'});
  } else if (admin && action==='invite') {
    if (!mailer) return json({error:'Email updates are not set up yet.'},409);
    const emails = [...new Set(clean(input.emails,20000).toLowerCase().split(/[\s,;]+/).filter(Boolean))];
    const valid = emails.filter(email => emailPattern.test(email)).slice(0,200);
    if (!valid.length) return json({error:'Enter at least one valid email address.'},400);
    let invited = 0;
    try { for (const email of valid) if (await subscribe(db,mailer,base,meeting,email) === 'invited') invited++; }
    catch (error) { console.error('Invite failed', error.code ?? error.name); return json({error:'Some invitations could not be sent. Try again.'},502); }
    const skipped = emails.length - valid.length;
    return json({ok:true,notice:`Sent ${invited} confirmation ${invited===1?'email':'emails'}.`+(skipped?` Skipped ${skipped} invalid ${skipped===1?'address':'addresses'}.`:'')});
  } else if (admin && action==='remove') {
    await run('DELETE FROM subscribers WHERE meeting=? AND email=?',id,clean(input.email,254).toLowerCase()).run();
  } else if (admin && action==='schedule') {
    const timezone = clean(input.timezone,64) || 'UTC';
    if (!validZone(timezone)) return json({error:'Choose a valid time zone.'},400);
    const local = clean(input.local,16);
    const start = local ? zonedToUtc(local,timezone) : null;
    if (local && !start) return json({error:'Enter a valid date and time.'},400);
    const duration = Math.max(5,Math.min(600,Number.parseInt(input.duration,10)||60));
    const previous = meeting.starts_at ? new Date(meeting.starts_at).toISOString() : null;
    await run('UPDATE meetings SET starts_at=?,timezone=?,duration=?,location=?,schedule=? WHERE id=?',
      start?.toISOString() ?? null,timezone,duration,clean(input.location,200),clean(input.schedule,120),id).run();
    const changed = start && start.toISOString() !== previous;
    let notice = '';
    if (changed && input.notify) {
      const updated = await run('SELECT * FROM meetings WHERE id=?',id).first();
      notice = await deliver(() => notify(db,mailer,updated,sub => agendaEmail({meeting:updated,sub,base,kind:'schedule'})));
    }
    return json({ok:true,notice});
  } else if (admin && action==='phase') {
    if (!['collect','vote'].includes(input.phase)) return json({error:'Invalid phase.'},400);
    await run('UPDATE meetings SET phase=? WHERE id=?',input.phase,id).run();
    let notice = '';
    if (input.phase === 'vote' && !sent.vote && mailer) {
      const topics = (await run('SELECT id,label,detail,kind FROM topics WHERE meeting=? ORDER BY created',id).all()).results;
      if (topics.length) {
        notice = await deliver(() => notify(db,mailer,meeting,sub => topicsEmail({meeting,sub,base,topics,
          subject:'Vote on the topics: '+meeting.title,intro:'Topic submissions are closed. Vote on what we should spend time on:'})));
        await run('UPDATE topics SET announced=true WHERE meeting=?',id).run();
        await markSent(db,meeting,{vote:true});
      }
    }
    return json({ok:true,notice});
  } else if (admin && action==='agenda') {
    const agenda = Array.isArray(input.agenda) ? input.agenda.slice(0,15).map(item=>({
      label:clean(item?.label,120),detail:clean(item?.detail,650),
      kind:kinds.includes(item?.kind)?item.kind:'Discussion',
      minutes:Math.max(1,Math.min(120,Number.parseInt(item?.minutes,10)||10))
    })).filter(item=>item.label) : [];
    if (!agenda.length) return json({error:'Add at least one agenda item.'},400);
    await run("UPDATE meetings SET agenda=?,phase='agenda' WHERE id=?",JSON.stringify(agenda),id).run();
    let notice = '';
    if (!sent.agenda && mailer) {
      const updated = await run('SELECT * FROM meetings WHERE id=?',id).first();
      notice = await deliver(() => notify(db,mailer,updated,sub => agendaEmail({meeting:updated,sub,base,kind:'agenda'})));
      await markSent(db,updated,{agenda:true});
    }
    return json({ok:true,notice});
  } else if (admin && action==='notes') {
    await run('UPDATE meetings SET notes=? WHERE id=?',clean(input.notes,7000),id).run();
  } else if (admin && action==='email') {
    if (!mailer) return json({error:'Email updates are not set up yet.'},409);
    if (!['agenda','outcomes'].includes(input.kind)) return json({error:'Invalid email.'},400);
    if (input.kind==='outcomes' && !meeting.notes) return json({error:'Save the outcomes first.'},400);
    if (input.kind==='agenda' && meeting.agenda==='[]') return json({error:'Publish the agenda first.'},400);
    const notice = await deliver(() => notify(db,mailer,meeting,sub => input.kind==='outcomes'
      ? outcomesEmail({meeting,sub,base}) : agendaEmail({meeting,sub,base,kind:'agenda'})));
    return json({ok:true,notice:notice || 'Nobody has confirmed email updates yet.'});
  } else return json({error:'This action is unavailable.'},403);
  return json({ok:true});
}
