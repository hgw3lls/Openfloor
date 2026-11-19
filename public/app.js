/* Tower Press: member pages, a separate organizer panel, and "preview as member". */
const root=document.querySelector('#app'), status=document.querySelector('#status'), nav=document.querySelector('#nav'), banner=document.querySelector('#banner');
const isId=v=>/^[a-f0-9-]{36}$/.test(v||'');
const parts=location.hash.slice(1).split('/');
const route={page:'home'};
// Organizers get the organizer version of a page by default; '/view' (or preview) shows the member version.
if(isId(parts[0])){route.page='meeting';route.id=parts[0];if(parts[1]==='manage')route.manage=true;else if(parts[1]==='view')route.view=true;else if(isId(parts[1])){route.secret=parts[1];route.manage=true;}}
else if(parts[0]==='event'&&isId(parts[1])){route.page='event';route.id=parts[1];route.manage=parts[2]==='manage';route.view=parts[2]==='view';}
else if(parts[0]==='post'&&isId(parts[1])){route.page='post';route.id=parts[1];}
else if(['organize','members','decisions','events','me'].includes(parts[0]))route.page=parts[0];

const categories=['Discussion','Decision','Update'];
const repeatLabels={'':'Does not repeat',weekly:'Every week',biweekly:'Every two weeks',monthly:'Every month (same weekday)'};
const rsvpLabels={yes:'Going',maybe:'Maybe',no:'Can’t make it'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const para=text=>esc(text).replace(/\n/g,'<br>');
const trap='<label class="trap" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>';
const options=selected=>categories.map(kind=>'<option'+(selected===kind?' selected':'')+'>'+kind+'</option>').join('');
const tell=message=>status.textContent=message||'';
const zone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
const zones=()=>{try{return Intl.supportedValuesOf('timeZone');}catch{return ['UTC'];}};
const zoneSelect=selected=>{const list=zones();if(!list.includes(selected))list.unshift(selected);return '<select name="timezone">'+list.map(z=>'<option'+(z===selected?' selected':'')+'>'+esc(z)+'</option>').join('')+'</select>';};
const repeatSelect=selected=>'<select name="repeat">'+Object.entries(repeatLabels).map(([v,l])=>'<option value="'+v+'"'+(v===(selected||'')?' selected':'')+'>'+l+'</option>').join('')+'</select>';
const dueText=d=>d?new Date(d+'T12:00:00Z').toLocaleDateString(undefined,{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}):'';
const overdue=a=>a.status==='open'&&a.due&&a.due<new Date().toISOString().slice(0,10);
const ago=ms=>{const m=Math.round((Date.now()-ms)/60000);return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'});};

let group, meeting, event, eventKinds=[], post, postList=[], eventList={upcoming:[],past:[]}, decisionsData=[], draft=[], editing='';

/* Preview as member: organizers see pages exactly as members do. */
let preview=false;
try{preview=localStorage.getItem('tp-preview')==='1';}catch{}
const setPreview=on=>{try{on?localStorage.setItem('tp-preview','1'):localStorage.removeItem('tp-preview');}catch{}};
const realOrganizer=()=>group?.me?.role==='organizer';
const organizer=()=>realOrganizer()&&!preview;

async function call(path,params,payload){
  const headers={};
  if(route.secret&&path==='/api/meeting')headers.Authorization='Bearer '+route.secret;
  if(payload!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(path+'?'+new URLSearchParams(params),{method:payload===undefined?'GET':'POST',headers,body:payload===undefined?undefined:JSON.stringify(payload)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error);
  return data;
}
const api=(action='',payload,meetingId=route.id)=>call('/api/meeting',{meeting:meetingId||'',action},payload);
const groupApi=(action='',payload,params={})=>call('/api/group',{action,...params},payload);
const postsApi=(action='',payload,params={})=>call('/api/posts',{action,...params},payload);
const eventsApi=(action='',payload,params={})=>call('/api/events',{action,...params},payload);

function hero(title,subtitle,badge='',extra=''){
  return '<section class="hero">'+(badge?'<span class="mono phase">'+badge+'</span>':'')+'<h1>'+esc(title)+'</h1>'+(subtitle?'<p>'+esc(subtitle)+'</p>':'')+extra+'</section>';
}
function header(){
  const me=group?.me;
  if(!me){nav.innerHTML='<a href="/">Sign in</a>';banner.innerHTML='';return;}
  const link=(href,label,page)=>'<a href="'+href+'"'+(route.page===page?' class="on"':'')+'>'+label+'</a>';
  const home=organizer()?link('/','Organizer',route.page==='organize'?'organize':'home')+link('#me','Your page','me'):link('/','Meetings',route.page==='me'?'me':'home');
  nav.innerHTML=home+link('#events','Events','events')+link('#decisions','Decisions','decisions')+
    '<span class="who">'+esc(me.name||me.email)+'</span>'+
    (realOrganizer()?'<button type="button" class="alt" data-action="preview">'+(preview?'Exit preview':'Preview as member')+'</button>':'');
  banner.innerHTML=preview?'You’re previewing the site as a regular member. <button type="button" data-action="preview">Exit preview</button>':'';
}
function orgbar(label,href){
  return organizer()?'<div class="orgbar"><strong>Organizer</strong><a class="button" href="'+href+'">'+label+'</a><span class="muted">Members see this page without these controls.</span></div>':'';
}
function comments(list,{kind,target,form=true,small=false}={}){
  return (list.length?'<ul class="comments'+(small?' small':'')+'">'+list.map(c=>'<li'+(c.hidden?' class="hidden-topic"':'')+'><div class="meta"><strong>'+esc(c.author)+'</strong> · '+ago(c.created)+(c.via==='email'?' · by email':'')+(c.hidden?' · hidden':'')+((c.mine||organizer())?' <button type="button" class="link" data-action="delete-comment" data-comment="'+c.id+'">Delete</button>':'')+'</div><div class="body">'+para(c.body)+'</div></li>').join('')+'</ul>':'')+
    (form?'<form class="reply" data-form="comment" data-kind="'+kind+'" data-target="'+target+'"><label><span class="sr">Your reply</span><textarea name="body" maxlength="3000" required placeholder="Write a reply…"></textarea></label><button>Reply</button></form>':'');
}
function actionRow(a,{showMeeting=false,canDone=false,canDelete=false}={}){
  return '<li class="action'+(a.status==='done'?' done':'')+'"><span><strong>'+esc(a.title)+'</strong> <span class="muted">'+[esc(a.ownerName||'No owner yet'),a.due?(overdue(a)?'<span class="late">overdue, was due '+esc(dueText(a.due))+'</span>':'due '+esc(dueText(a.due))):'',showMeeting?'<a href="#'+a.meeting+(organizer()?'/view':'')+'">'+esc(a.meetingTitle)+'</a>':''].filter(Boolean).join(' · ')+'</span></span><span class="actions">'+
    (canDone?'<button type="button" class="'+(a.status==='done'?'alt ':'')+'small" data-action="action-done" data-item="'+a.id+'" data-meeting="'+a.meeting+'" data-done="'+(a.status!=='done')+'">'+(a.status==='done'?'Reopen':'Done')+'</button>':'')+
    (canDelete?'<button type="button" class="alt small" data-action="action-delete" data-item="'+a.id+'">Delete</button>':'')+'</span></li>';
}
function timeFields(m){
  return '<div class="row"><label>Starts<input type="datetime-local" name="local" value="'+esc(m.local||'')+'"></label><label>Time zone'+zoneSelect(m.timezone||zone())+'</label></div>'+
    '<div class="row"><label>Length (minutes)<input type="number" name="duration" min="5" max="600" value="'+esc(m.duration||60)+'"></label><label>Repeats'+repeatSelect(m.repeat)+'</label></div>'+
    '<label>Place or video link<input name="location" maxlength="200" value="'+esc(m.location||'')+'"></label>'+
    '<label>Note under the title <small>(optional)</small><input name="schedule" maxlength="120" value="'+esc(m.schedule||'')+'"></label>';
}

/* Signed out */
function welcome(){
  const setup='<form class="draft" data-form="setup"><label>Organizer key<input type="password" name="organizerKey" required autocomplete="off"></label><label>Your name<input name="name" maxlength="80" required></label><label>Your email<input type="email" name="email" required maxlength="254"></label><button>Set up and sign in</button></form>';
  root.innerHTML=hero(group.group,'Meetings, events, agendas and decisions for the group, in one place.')+
    (group.needsSetup?'<section class="panel admin"><h2>Set up the group</h2><p class="muted">No organizers yet. Enter the organizer key from Vercel to become the first organizer.</p>'+setup+'</section>':'')+
    '<form class="panel" data-form="signin"><h2>Sign in</h2><p class="muted">Members get a sign-in link by email. No password needed.</p><label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label><button>Email me a sign-in link</button></form>'+
    '<form class="panel" data-form="join"><h2>Join the group</h2><p class="muted">Ask to join. An organizer will approve you, and you’ll get an email.</p><label>Name<input name="name" required maxlength="80" autocomplete="name"></label><label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label>'+trap+'<button>Ask to join</button></form>'+
    (group.needsSetup?'':'<details class="panel"><summary>Organizer key</summary><p class="muted">Lost access? The organizer key from Vercel signs you in as an organizer.</p>'+setup+'</details>');
}

/* Member dashboard */
function meetingCard(m){
  const chip=m.mine?'<span class="chip rsvp-'+m.mine+'">'+rsvpLabels[m.mine]+'</span>':(m.past?'':'<span class="chip todo">RSVP needed</span>');
  return '<a class="card" href="#'+m.id+(organizer()?'/view':'')+'"><strong>'+esc(m.title)+'</strong><span class="muted">'+esc(m.when||'Date to be set')+(m.location?' · '+esc(m.location):'')+'</span><span class="mono">'+chip+(m.going?'<span>'+m.going+' going</span>':'')+'</span></a>';
}
function eventCard(e){
  const open=e.spots-e.taken;
  return '<a class="card" href="#event/'+e.id+(organizer()&&route.page!=='events'?'/view':'')+'"><span class="mono"><span class="tag">'+esc(e.kind)+'</span>'+(e.signedUp?'<span class="chip rsvp-yes">You’re helping</span>':'')+(open>0?'<span class="chip todo">'+open+(open===1?' spot':' spots')+' open</span>':'')+(e.hidden?'<span>hidden</span>':'')+'</span><strong>'+esc(e.title)+'</strong><span class="muted">'+esc(e.when)+(e.location?' · '+esc(e.location):'')+'</span></a>';
}
function dashboard(){
  const me=group.me;
  root.innerHTML=hero(group.group,'Hi'+(me.name?', '+me.name:'')+'.')+
    orgbar('Back to the organizer panel','/')+
    (group.myActions?.length?'<section class="panel"><h2>Your action items</h2><ul class="subs">'+group.myActions.map(a=>actionRow(a,{showMeeting:true,canDone:true})).join('')+'</ul></section>':'')+
    (group.mySlots?.length?'<section class="panel"><h2>Your sign-ups</h2><ul class="subs">'+group.mySlots.map(s=>'<li><span><strong>'+esc(s.label)+'</strong> <span class="muted">'+esc(s.when)+' · <a href="#event/'+s.event+(organizer()?'/view':'')+'">'+esc(s.eventTitle)+'</a></span></span></li>').join('')+'</ul></section>':'')+
    '<section class="panel"><h2>Upcoming meetings</h2>'+(group.meetings.upcoming.length?group.meetings.upcoming.map(meetingCard).join(''):'<p class="muted">No meetings scheduled yet.</p>')+'</section>'+
    '<section class="panel"><h2>Coming up</h2>'+(group.comingUp?.length?group.comingUp.map(eventCard).join(''):'<p class="muted">No events yet.</p>')+'<p><a href="#events">All events, and add your own →</a></p></section>'+
    '<section class="panel"><h2>Posts</h2><p class="muted">Announcements, questions and news for the group. Everyone gets them by email and can reply from their inbox.</p>'+
      (postList.length?postList.map(p=>'<a class="card" href="#post/'+p.id+'"><strong>'+(p.pinned?'📌 ':'')+esc(p.title)+'</strong><span class="muted">'+esc(p.author)+' · '+ago(p.created)+(p.replies?' · '+p.replies+(p.replies===1?' reply':' replies'):'')+(p.hidden?' · hidden':'')+'</span>'+(p.excerpt?'<span>'+esc(p.excerpt)+(p.excerpt.length>=240?'…':'')+'</span>':'')+'</a>').join(''):'<p class="muted">No posts yet.</p>')+
      '<details class="draft"><summary>Write a post</summary><form data-form="post"><label>Title<input name="title" required maxlength="140"></label><label>Message<textarea name="body" maxlength="6000" rows="6"></textarea></label><button>Post to the group</button></form></details></section>'+
    (group.meetings.past.length?'<section class="panel"><h2>Past meetings</h2>'+group.meetings.past.map(meetingCard).join('')+'</section>':'')+
    calendarPanel()+settingsForm(me);
}
function calendarPanel(){
  const url=group.feedUrl;
  if(!url)return '<section class="panel"><h2>Your calendar</h2><p class="muted">Get every meeting and event, your sign-ups, and your action items’ due dates in Google, Apple or Outlook calendar. It updates on its own.</p><button type="button" data-action="feed">Get my calendar link</button></section>';
  const webcal=url.replace(/^https?:/,'webcal:');
  return '<section class="panel"><h2>Your calendar</h2><p class="muted">Add this link to your calendar once; new meetings and events appear on their own. Keep it private: it’s yours.</p><label>Calendar link<input readonly id="feed" value="'+esc(url)+'"></label><div class="actions"><a class="button alt" href="https://calendar.google.com/calendar/r?cid='+encodeURIComponent(webcal)+'" target="_blank" rel="noopener">Add to Google Calendar</a><a class="button alt" href="'+esc(webcal)+'">Add to Apple or Outlook</a><button type="button" class="alt" data-action="copy" data-target="#feed">Copy link</button><button type="button" class="alt" data-action="feed">Make a new link</button></div></section>';
}
function settingsForm(me){
  const value=me.emails==='none'?'none':me.digest;
  const opt=(v,l,d)=>'<label class="pick"><input type="radio" name="email" value="'+v+'"'+(value===v?' checked':'')+'> <span><strong>'+l+'</strong><br><span class="muted">'+d+'</span></span></label>';
  return '<form class="panel" data-form="profile"><h2>Your settings</h2><label>Name<input name="name" maxlength="80" value="'+esc(me.name)+'"></label><fieldset class="stack"><legend>Email</legend>'+
    opt('instant','Everything right away','Each post and reply as it happens.')+opt('daily','Daily summary','One email a day with new posts, replies, topics and events.')+opt('weekly','Weekly summary','One email on Mondays.')+opt('none','Off','No emails at all, not even meeting invitations.')+
    '</fieldset><p class="muted">Meeting invitations, agendas and reminders always come right away unless email is off.</p><div class="actions"><button>Save</button><button type="button" class="alt" data-action="signout">Sign out</button></div></form>';
}

/* Organizer panel */
function organize(){
  const o=group.overview, m=o.members, a=o.actions, e=o.email;
  const help=(group.helpWanted||[]);
  const attention=[
    m.requested?'<li><a href="#members">'+m.requested+(m.requested===1?' person wants':' people want')+' to join</a></li>':'',
    a.overdue?'<li>'+a.overdue+' overdue action '+(a.overdue===1?'item':'items')+' (they’ll show in the agenda builder)</li>':'',
    a.unowned?'<li>'+a.unowned+' action '+(a.unowned===1?'item has':'items have')+' no owner</li>':'',
    ...help.map(ev=>'<li><a href="#event/'+ev.id+'">'+esc(ev.title)+'</a> needs '+(ev.spots-ev.taken)+' more '+((ev.spots-ev.taken)===1?'helper':'helpers')+'</li>'),
    e.failed?'<li class="late">'+e.failed+' '+(e.failed===1?'email':'emails')+' couldn’t be sent after 5 tries</li>':'',
    m.invited?'<li>'+m.invited+' invited '+(m.invited===1?'person hasn’t':'people haven’t')+' joined yet</li>':''].filter(Boolean);
  const checked=e.repliesCheckedAt?ago(e.repliesCheckedAt):'not yet';
  root.innerHTML=hero('Organizer','Everything that needs your attention, in one place.')+
    '<div class="stats"><div class="stat"><a href="#members"><b>'+m.active+'</b>members</a></div><div class="stat"><b>'+o.meetings.length+'</b>upcoming meetings</div><div class="stat"><b>'+a.open+'</b>open action items</div><div class="stat"><b>'+e.sent_today+'/'+e.limit+'</b>emails today</div></div>'+
    '<section class="panel admin"><h2>Needs attention</h2>'+(attention.length?'<ul class="attention">'+attention.join('')+'</ul>':'<p class="muted">Nothing right now.</p>')+'</section>'+
    '<section class="panel"><h2>Meetings</h2>'+(o.meetings.length?'<ul class="subs">'+o.meetings.map(x=>'<li><span><strong>'+esc(x.title)+'</strong> <span class="muted">'+esc(x.when)+' · '+x.going+' going · '+x.maybe+' maybe · '+x.declined+' can’t · '+x.noAnswer+' no answer · '+x.topics+(x.topics===1?' topic':' topics')+'</span></span><span class="actions"><a class="button alt small" href="#'+x.id+'/view">Member page</a><a class="button small" href="#'+x.id+'">Manage</a></span></li>').join('')+'</ul>':'<p class="muted">No upcoming meetings.</p>')+
      '<details class="draft"><summary>New meeting</summary><form data-form="new-meeting"><p class="muted">Everyone on the member list gets an email with RSVP buttons.</p><label>Name<input name="title" required maxlength="100" placeholder="Monthly members meeting"></label>'+timeFields({timezone:zone(),duration:90})+'<button>Create and invite members</button></form></details></section>'+
    organizersPanel()+
    '<section class="panel"><h2>Quick links</h2><div class="actions"><a class="button alt" href="#members">Members and invitations</a><a class="button alt" href="#events">Events and sign-ups</a><a class="button alt" href="#decisions">Decisions</a></div>'+
      '<h3>Download</h3><div class="actions"><a class="button alt" href="/api/export?what=members">Members</a><a class="button alt" href="/api/export?what=meetings">Meetings and outcomes</a><a class="button alt" href="/api/export?what=attendance">Attendance</a></div></section>'+
    '<section class="panel"><h2>Email</h2><p>'+e.sent_today+' sent in the last 24 hours (limit '+e.limit+') · '+e.waiting+' waiting · '+e.retrying+' being retried · '+e.failed+' failed</p><p class="muted">Email replies last checked '+esc(checked)+'. '+m.no_email+(m.no_email===1?' member has':' members have')+' email turned off.</p></section>'+
    '<section class="panel"><h2>See it as a member</h2><p class="muted">Preview shows every page exactly as a regular member sees it: no vote counts before the agenda, no hidden topics, no organizer tools.</p><button type="button" data-action="preview">Preview as member</button></section>';
}
function organizersPanel(){
  const list=group.members||[], orgs=list.filter(m=>m.role==='organizer'&&m.status==='active'), pending=list.filter(m=>m.role==='organizer'&&m.status==='invited');
  const candidates=list.filter(m=>m.status==='active'&&m.role!=='organizer');
  const only=orgs.length<=1;
  return '<section class="panel"><h2>Organizers</h2><p class="muted">Organizers run meetings and events, manage members, and see this panel. Join requests are emailed to all of them.</p>'+
    '<ul class="subs">'+orgs.map(m=>'<li><span><strong>'+esc(m.name||m.email)+'</strong> <span class="muted">'+esc(m.email)+(m.id===group.me.id?' · you':'')+'</span></span><span class="actions">'+(only?'<span class="muted">The group needs at least one</span>':'<button type="button" class="alt small" data-action="role" data-member="'+m.id+'" data-role="member">'+(m.id===group.me.id?'Step down':'Make member')+'</button>')+'</span></li>').join('')+
      pending.map(m=>'<li><span><strong>'+esc(m.name||m.email)+'</strong> <span class="muted">invited as organizer, hasn’t joined yet</span></span></li>').join('')+'</ul>'+
    (candidates.length?'<form data-form="promote" class="draft"><label>Make a member an organizer<select name="member">'+candidates.map(m=>'<option value="'+m.id+'">'+esc(m.name||m.email)+(m.name?' · '+esc(m.email):'')+'</option>').join('')+'</select></label><button>Make organizer</button></form>':'')+
    '<p class="muted">Not a member yet? <a href="#members">Invite them as an organizer</a>.</p></section>';
}
function members(){
  const list=group.members||[], requests=list.filter(m=>m.status==='requested'), orgs=list.filter(m=>m.status!=='requested'&&m.role==='organizer'), rest=list.filter(m=>m.status!=='requested'&&m.role!=='organizer');
  const label={active:'Member',invited:'Invited, hasn’t joined yet'};
  const row=m=>'<li><span><strong>'+esc(m.name||m.email)+'</strong> <span class="muted">'+(m.name?esc(m.email)+' · ':'')+(m.role==='organizer'?(m.status==='invited'?'Invited as organizer, hasn’t joined yet':'Organizer'):label[m.status]||m.status)+(m.emails==='none'?' · emails off':'')+'</span></span><span class="actions">'+
    (m.status==='requested'?'<button type="button" class="small" data-action="approve" data-member="'+m.id+'">Approve</button><button type="button" class="alt small" data-action="decline" data-member="'+m.id+'">Decline</button>':
     (m.status==='active'?'<button type="button" class="alt small" data-action="role" data-member="'+m.id+'" data-role="'+(m.role==='organizer'?'member':'organizer')+'">'+(m.role==='organizer'?'Make member':'Make organizer')+'</button>':'')+
     (m.id!==group.me.id?'<button type="button" class="alt small" data-action="remove-member" data-member="'+m.id+'" data-name="'+esc(m.name||m.email)+'">Remove</button>':''))+'</span></li>';
  root.innerHTML=hero('Members',list.filter(m=>m.status==='active').length+' active members','','<p><a href="/">← Organizer panel</a></p>')+
    (requests.length?'<section class="panel admin"><h2>Waiting for approval</h2><ul class="subs">'+requests.map(row).join('')+'</ul></section>':'')+
    '<form class="panel" data-form="add-members"><h2>Add people</h2><p class="muted">One person per line, like <code>Ana Ruiz &lt;ana@example.org&gt;</code> or just an email. Each person gets an invitation to accept, so nobody is added without agreeing.</p><label>People<textarea name="people" maxlength="20000"></textarea></label><label class="check"><input type="checkbox" name="organizer"> Make them organizers</label><button>Send invitations</button></form>'+
    '<section class="panel"><h2>Organizers</h2><ul class="subs">'+orgs.map(row).join('')+'</ul></section>'+
    '<section class="panel"><h2>Member list</h2>'+(rest.length?'<ul class="subs">'+rest.map(row).join('')+'</ul>':'<p class="muted">No members yet.</p>')+'</section>';
}

/* Meetings: member view */
function topicItem(item,{manage=false}={}){
  if(editing===item.id)return '<form class="topic" data-form="topic-edit" data-topic="'+item.id+'"><label>Topic<input name="label" maxlength="120" required value="'+esc(item.label)+'"></label><label>Details<textarea name="detail" maxlength="650">'+esc(item.detail)+'</textarea></label><label>Type<select name="kind">'+options(item.kind)+'</select></label><div class="actions"><button>Save topic</button><button type="button" class="alt" data-action="cancel-edit">Cancel</button></div></form>';
  const open=meeting.phase!=='agenda';
  const counts=item.up!==null&&item.up!==undefined?'<span>👍 '+item.up+' · 👎 '+item.down+'</span>':'';
  const tags=(item.own?'<span class="tag">Your topic</span>':'')+(item.carried?'<span class="tag">Carried over</span>':'')+(item.hidden?'<span class="tag">Hidden from members</span>':'');
  const votes=!manage&&open&&meeting.me&&!item.own&&!item.hidden?'<div class="votes"><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="1" aria-pressed="'+(item.mine>0)+'" aria-label="Vote up: '+esc(item.label)+'">👍 Up</button><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="-1" aria-pressed="'+(item.mine<0)+'" aria-label="Vote down: '+esc(item.label)+'">👎 Down</button></div>':'';
  const talk=item.comments?.length?'<details class="talk"><summary>'+item.comments.length+(item.comments.length===1?' comment':' comments')+'</summary>'+comments(item.comments,{form:false,small:true})+'</details>':'';
  const tools=manage?'<div class="actions"><button type="button" class="alt small" data-action="edit-topic" data-topic="'+item.id+'">Edit</button><button type="button" class="alt small" data-action="hide-topic" data-topic="'+item.id+'" data-hidden="'+!item.hidden+'">'+(item.hidden?'Show':'Hide')+'</button><button type="button" class="alt small" data-action="delete-topic" data-topic="'+item.id+'">Delete</button></div>':'';
  return '<div class="topic'+(item.hidden?' hidden-topic':'')+'"><strong>'+esc(item.label)+'</strong><div class="mono"><span class="tag">'+esc(item.kind)+'</span>'+tags+counts+'</div>'+(item.detail?'<p>'+esc(item.detail)+'</p>':'')+votes+talk+tools+'</div>';
}
function rsvpPanel(){
  const a=meeting.attendance, mine=meeting.rsvp;
  const names=list=>list.length?esc(list.join(', ')):'<span class="muted">nobody yet</span>';
  const coming='<p><strong>Going ('+a.going.length+'):</strong> '+names(a.going)+'</p>'+(a.maybe.length?'<p><strong>Maybe ('+a.maybe.length+'):</strong> '+names(a.maybe)+'</p>':'');
  if(!meeting.me)return '<section class="panel"><h2>Who’s coming</h2>'+coming+'</section>';
  const choice=s=>'<label class="pick"><input type="radio" name="status" value="'+s+'"'+(mine?.status===s?' checked':'')+'> '+rsvpLabels[s]+'</label>';
  return '<form class="panel" data-form="rsvp"><h2>Can you make it?</h2>'+(mine?'<p class="mono"><span class="chip rsvp-'+mine.status+'">You: '+rsvpLabels[mine.status]+'</span></p>':'')+
    (meeting.past?'<p class="muted">This meeting has happened.</p>':'<fieldset class="choices">'+choice('yes')+choice('maybe')+choice('no')+'</fieldset><label data-reason'+(mine?.status==='no'||mine?.status==='maybe'?'':' hidden')+'>Reason <small>(needed if you can’t make it; only organizers see it)</small><textarea name="reason" maxlength="500">'+esc(mine?.reason)+'</textarea></label><button>Save RSVP</button>')+
    coming+'</form>';
}
function joinPrompt(){
  return '<form class="panel" data-form="signin"><h2>Take part</h2><p class="muted">Sign in to RSVP, suggest topics and vote. Members get a sign-in link by email.</p><label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label><button>Email me a sign-in link</button><p class="muted"><a href="/">Not a member? Ask to join.</a></p></form>';
}
function meetingHero(){
  const subtitle=meeting.when?meeting.when+(meeting.location?' · '+meeting.location:''):meeting.schedule;
  const extra='<p class="when">'+(meeting.startsAt?'<a href="/api/calendar?meeting='+meeting.id+'">Add to calendar</a>':'')+(meeting.when&&meeting.schedule?' · '+esc(meeting.schedule):'')+(meeting.repeat?' · '+repeatLabels[meeting.repeat]:'')+'</p>';
  return hero(meeting.title,subtitle,{collect:'Topics and voting open',vote:'Final vote',agenda:'Agenda published'}[meeting.phase],extra);
}
function meetingView(){
  const open=meeting.phase!=='agenda', list=meeting.actions||[];
  root.innerHTML=meetingHero()+orgbar('Manage this meeting','#'+meeting.id)+
    rsvpPanel()+
    (meeting.phase==='agenda'?'<section class="panel"><h2>Agenda</h2><p class="mono">'+meeting.agenda.reduce((total,item)=>total+item.minutes,0)+' minutes</p>'+meeting.agenda.map(item=>'<div class="topic"><div class="mono"><span class="tag">'+esc(item.kind)+'</span>'+item.minutes+' min</div><strong>'+esc(item.label)+'</strong>'+(item.detail?'<p>'+para(item.detail)+'</p>':'')+'</div>').join('')+'</section>':'')+
    (meeting.notes?'<section class="panel"><h2>Decisions and next steps</h2><div class="note">'+esc(meeting.notes)+'</div></section>':'')+
    (list.length?'<section class="panel"><h2>Action items</h2><ul class="subs">'+list.map(a=>actionRow(a,{canDone:a.mine})).join('')+'</ul></section>':'')+
    (meeting.phase==='collect'&&meeting.me?'<form class="panel" data-form="topic"><h2>Suggest a topic</h2><p class="muted">What should we make time for? Members see your topic and vote on it; you can’t vote on your own.</p><label>Topic<input name="label" maxlength="120" required></label><label>What would you like to happen? <small>(optional)</small><textarea name="detail" maxlength="650"></textarea></label><label>Type<select name="kind">'+options('Discussion')+'</select></label>'+trap+'<button>Submit topic</button></form>':'')+
    (open?'<section class="panel"><h2>Submitted topics</h2>'+(meeting.topics.length?(meeting.me?'<p class="muted">Vote 👍 or 👎 on any topic. Tap again to take your vote back.</p>':'')+meeting.topics.map(t=>topicItem(t)).join(''):'<p class="muted">No topics yet.</p>')+'</section>':'')+
    (meeting.me?'<section class="panel"><h2>Discussion</h2><p class="muted">Questions and notes about this meeting. You can also reply to any meeting email.</p>'+comments(meeting.discussion||[],{kind:'meeting',target:meeting.id})+'</section>':joinPrompt());
}

/* Meetings: organizer page */
function drawDraft(){
  const container=document.querySelector('#draft');
  if(!container)return;
  container.innerHTML=draft.map((item,i)=>'<div class="draft" data-row><label>Topic<input name="label" required maxlength="120" value="'+esc(item.label)+'"></label><label>What needs to happen?<textarea name="detail" maxlength="650">'+esc(item.detail)+'</textarea></label><label>Type<select name="kind">'+options(item.kind)+'</select></label><label>Minutes<input name="minutes" type="number" min="1" max="120" required value="'+item.minutes+'"></label><div class="actions">'+(i?'<button type="button" class="alt" data-action="up" data-index="'+i+'">Move up</button>':'')+'<button type="button" class="alt" data-action="remove" data-index="'+i+'">Remove</button></div></div>').join('');
  container.nextElementSibling.disabled=!draft.length;
}
function readDraft(){
  draft=[...document.querySelectorAll('[data-row]')].map(row=>Object.fromEntries([...row.querySelectorAll('[name]')].map(field=>[field.name,field.value])));
}
function meetingManage(){
  const a=meeting.attendance, list=meeting.actions||[], link=(meeting.appUrl||location.origin)+'/#'+meeting.id;
  root.innerHTML=hero('Manage: '+meeting.title,meeting.when||meeting.schedule||'Date to be set',{collect:'Topics and voting open',vote:'Final vote',agenda:'Agenda published'}[meeting.phase],'<p><a href="#'+meeting.id+'/view">See the member page (to RSVP and vote)</a> · <a href="/">← Organizer panel</a></p>')+
    '<section class="panel admin"><h2>Share and stage</h2><label>Meeting link<input readonly id="invite" value="'+esc(link)+'"></label><div class="actions"><button type="button" data-action="copy" data-target="#invite" class="alt">Copy link</button>'+
      (meeting.phase!=='collect'?'<button type="button" data-action="collect" class="alt">Reopen submissions</button>':'')+
      (meeting.phase==='collect'&&meeting.topics.length?'<button type="button" data-action="phase-vote" class="alt">Close submissions, final vote</button>':'')+'</div></section>'+
    '<section class="panel admin"><h2>Attendance</h2><p>'+a.going.length+' going · '+a.maybe.length+' maybe · '+a.declined.length+' can’t make it · '+a.noAnswer.length+' haven’t answered</p>'+
      (a.going.length?'<p><strong>Going:</strong> '+esc(a.going.join(', '))+'</p>':'')+(a.maybe.length?'<p><strong>Maybe:</strong> '+esc(a.maybe.join(', '))+'</p>':'')+
      (a.declined.length?'<h3>Can’t make it</h3><ul class="subs">'+a.declined.map(d=>'<li><span><strong>'+esc(d.name)+'</strong> <span class="muted">'+esc(d.reason)+'</span></span></li>').join('')+'</ul>':'')+
      (a.noAnswer.length?'<h3>Haven’t answered</h3><p class="muted">'+esc(a.noAnswer.join(', '))+'</p><div class="actions"><button type="button" class="alt" data-action="nudge">Email a reminder to people who haven’t answered</button></div>':'')+'</section>'+
    '<section class="panel admin"><h2>Topics</h2><p class="muted">With vote counts. Hide or delete anything that doesn’t belong.</p>'+(meeting.topics.length?meeting.topics.map(t=>topicItem(t,{manage:true})).join(''):'<p class="muted">No topics yet.</p>')+'</section>'+
    '<form data-form="agenda" class="panel admin"><h2>Agenda</h2><p class="muted">Edit the suggested order, make room for urgent items, and publish when ready. Publishing closes submissions and voting and emails the agenda to members.</p><div class="actions"><button type="button" data-action="suggest" class="alt" '+(meeting.topics.length?'':'disabled')+'>Use top three topics</button><button type="button" data-action="add" class="alt">Add agenda item</button>'+(meeting.openActions?.length?'<button type="button" data-action="add-actions" class="alt">Add open action items ('+meeting.openActions.length+')</button>':'')+'</div><div id="draft"></div><button '+(draft.length?'':'disabled')+'>Publish agenda</button></form>'+
    '<section class="panel admin"><h2>Outcomes and action items</h2>'+
      (meeting.agenda.length?'<form data-form="notes"><label>Decisions and next steps<textarea name="notes" maxlength="7000" placeholder="What did we decide?">'+esc(meeting.notes)+'</textarea></label><div class="actions"><button>Save outcomes</button>'+((meeting.notes||list.length)?'<button type="button" class="alt" data-action="mail-outcomes">Email outcomes and action items</button>':'')+'<button type="button" class="alt" data-action="mail-agenda">Email agenda again</button></div></form>':'<p class="muted">Publish the agenda to record outcomes.</p>')+
      (list.length?'<ul class="subs">'+list.map(x=>actionRow(x,{canDone:true,canDelete:true})).join('')+'</ul>':'')+
      '<form data-form="action-add" class="draft"><h3>Add an action item</h3><label>What needs to happen?<input name="title" required maxlength="200" placeholder="Book the gallery for March"></label><div class="row"><label>Who<select name="owner"><option value="">Nobody yet</option>'+(meeting.memberOptions||[]).map(m=>'<option value="'+m.id+'">'+esc(m.name)+'</option>').join('')+'</select></label><label>Due<input type="date" name="due"></label></div><button>Add action item</button><p class="muted">The owner gets an email, and reminders before it’s due.</p></form></section>'+
    (meeting.phase==='agenda'&&meeting.otherMeetings?.length?'<form data-form="carry" class="panel admin"><h2>Carry topics over</h2><p class="muted">Move topics that didn’t make this agenda to another meeting. Repeating meetings do this on their own.</p><label>To<select name="to">'+meeting.otherMeetings.map(m=>'<option value="'+m.id+'">'+esc(m.title)+(m.when?' · '+esc(m.when):'')+'</option>').join('')+'</select></label><button>Move unused topics</button></form>':'')+
    '<form data-form="schedule" class="panel admin"><h2>Meeting details</h2><label>Name<input name="title" maxlength="100" required value="'+esc(meeting.title)+'"></label>'+timeFields(meeting)+
      '<label class="check"><input type="checkbox" name="notify" checked> Email members if the time changes</label><button>Save details</button></form>'+
    (organizer()?'<section class="panel admin"><h2>Delete meeting</h2><p class="muted">Removes the meeting with its topics, votes, RSVPs, action items and discussion. This can’t be undone.'+(meeting.repeat?' This meeting repeats: deleting it won’t bring it back, and if it’s the latest one the series stops.':'')+'</p>'+
      (!meeting.past&&meeting.sent?.announced?'<label class="check"><input type="checkbox" id="notify-cancel" checked> Email members that it’s cancelled</label>':'')+
      '<button type="button" class="alt" data-action="delete-meeting">Delete this meeting</button></section>':'');
  drawDraft();
}

/* Events */
const minutesBetween=(a,b)=>a&&b?Math.round((Date.parse(b)-Date.parse(a))/60000):0;
const addMinutes=(local,mins)=>{if(!local)return '';const d=new Date(Date.parse(local)+mins*60000);const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());};
function eventFields(e={}){
  return '<label>Name<input name="title" required maxlength="140" value="'+esc(e.title||'')+'" placeholder="Winter group show"></label>'+
    '<div class="row"><label>Type<select name="kind">'+eventKinds.map(k=>'<option'+((e.kind||'Event')===k?' selected':'')+'>'+k+'</option>').join('')+'</select></label><label>Time zone'+zoneSelect(e.timezone||zone())+'</label></div>'+
    '<div class="row"><label>Starts<input type="datetime-local" name="local" required value="'+esc(e.local||'')+'"></label><label>Ends<input type="datetime-local" name="ends" value="'+esc(e.local?addMinutes(e.local,e.duration):'')+'"></label></div>'+
    '<label>Place<input name="location" maxlength="200" value="'+esc(e.location||'')+'"></label><label>Link <small>(optional)</small><input name="link" maxlength="500" value="'+esc(e.link||'')+'" placeholder="https://"></label>'+
    '<label>Details<textarea name="description" maxlength="4000">'+esc(e.description||'')+'</textarea></label>';
}
function eventsPage(){
  root.innerHTML=hero('Events','Shows, openings, workshops and workdays. Add your own, and sign up to help.')+
    '<section class="panel"><h2>Coming up</h2>'+(eventList.upcoming.length?eventList.upcoming.map(eventCard).join(''):'<p class="muted">Nothing yet.</p>')+'</section>'+
    '<details class="panel"><summary>Add an event</summary><form data-form="event-create">'+eventFields()+'<button>Add event</button><p class="muted">You can add sign-up slots, like gallery sitting or install crew, on the next page.</p></form></details>'+
    (eventList.past.length?'<section class="panel"><h2>Past</h2>'+eventList.past.map(eventCard).join('')+'</section>':'');
}
function slotRow(s,{manage=false}={}){
  const full=s.taken>=s.capacity, people=s.people.map(p=>p.name);
  return '<div class="slot"><span><strong>'+esc(s.label)+'</strong>'+(s.when?'<br><span class="who">'+esc(s.when)+'</span>':'')+'<br><span class="who">'+s.taken+' of '+s.capacity+(people.length?': '+esc(people.join(', ')):'')+'</span></span><span class="actions">'+
    (manage?s.people.map(p=>'<button type="button" class="alt small" data-action="remove-claim" data-slot="'+s.id+'" data-member="'+p.id+'">Remove '+esc(p.name)+'</button>').join('')+'<button type="button" class="alt small" data-action="slot-delete" data-slot="'+s.id+'">Delete slot</button>':
      event.past?'':s.mine?'<button type="button" class="alt small" data-action="unclaim" data-slot="'+s.id+'">Drop out</button>':full?'<span class="full">Full</span>':'<button type="button" class="small" data-action="claim" data-slot="'+s.id+'">Sign me up</button>')+'</span></div>';
}
function eventView(){
  const e=event;
  root.innerHTML=hero(e.title,e.when+(e.location?' · '+e.location:''),e.kind,e.link?'<p class="when"><a href="'+esc(e.link)+'" target="_blank" rel="noopener">'+esc(e.link)+'</a></p>':'')+
    (e.canEdit&&!preview?'<div class="orgbar"><strong>'+(organizer()?'Organizer':'Your event')+'</strong><a class="button" href="#event/'+e.id+(organizer()?'':'/manage')+'">Manage this event</a></div>':'')+
    (e.description?'<section class="panel"><div class="note">'+para(e.description)+'</div><p class="muted">Added by '+esc(e.author||'a member')+'</p></section>':'')+
    (e.slots.length?'<section class="panel"><h2>Help needed</h2><p class="muted">Sign up for a slot. You’ll get a reminder the day before.</p>'+e.slots.map(s=>slotRow(s)).join('')+'</section>':'')+
    '<section class="panel"><h2>Discussion</h2>'+comments(e.comments,{kind:'event',target:e.id})+'</section>';
}
function eventManage(){
  const e=event;
  root.innerHTML=hero('Manage: '+e.title,e.when,e.kind,'<p><a href="#event/'+e.id+'/view">See the event page (to sign up)</a>'+(organizer()?' · <a href="/">← Organizer panel</a>':'')+'</p>')+
    '<section class="panel admin"><h2>Sign-up slots</h2>'+(e.slots.length?e.slots.map(s=>slotRow(s,{manage:true})).join(''):'<p class="muted">No slots yet.</p>')+
      '<form data-form="slot-add" class="draft"><h3>Add a slot</h3><label>What<input name="label" required maxlength="140" placeholder="Gallery sitting, Saturday 12–3"></label><div class="row"><label>When <small>(optional)</small><input type="datetime-local" name="local"></label><label>People needed<input type="number" name="capacity" min="1" max="100" value="1"></label></div><label>Length (minutes) <small>(optional)</small><input type="number" name="duration" min="0" max="1440" value="180"></label><button>Add slot</button></form></section>'+
    (organizer()?'<section class="panel admin"><h2>Email</h2><div class="actions"><button type="button" data-action="event-announce">'+(e.announced?'Email everyone again':'Email everyone about this event')+'</button><button type="button" class="alt" data-action="event-help">Ask for help (people not signed up yet)</button></div><p class="muted">Events also appear in members’ daily or weekly summaries.</p></section>':'')+
    '<form data-form="event-update" class="panel admin"><h2>Details</h2>'+eventFields(e)+'<button>Save</button></form>'+
    (organizer()?'<section class="panel admin"><h2>Hide</h2><p class="muted">Hidden events disappear for members but keep their sign-ups and discussion.</p><button type="button" class="alt" data-action="event-hide" data-hidden="'+!e.hidden+'">'+(e.hidden?'Show event':'Hide event')+'</button></section>':'')+
    '<section class="panel admin"><h2>Delete event</h2><p class="muted">Removes the event with its sign-up slots and discussion. This can’t be undone.</p>'+
      (!e.past&&(e.announced||e.slots.reduce((n,x)=>n+x.taken,0))?'<label class="check"><input type="checkbox" id="notify-cancel" checked> '+(e.announced?'Email everyone that it’s cancelled':'Email the people who signed up that it’s cancelled')+'</label>':'')+
      '<button type="button" class="alt" data-action="event-delete">Delete this event</button></section>';
}

/* Posts and decisions */
function postPage(){
  const p=post;
  root.innerHTML=hero(p.title,p.author+' · '+ago(p.created)+(p.hidden?' · hidden':''),p.pinned?'Pinned':'','<p><a href="/">← Back</a></p>')+
    (p.body?'<section class="panel"><div class="note">'+para(p.body)+'</div></section>':'')+
    '<section class="panel"><h2>Replies</h2>'+comments(p.comments,{kind:'post',target:p.id})+'</section>'+
    ((organizer()||p.mine)?'<section class="panel admin"><div class="actions">'+(organizer()?'<button type="button" class="alt" data-action="pin-post" data-pinned="'+!p.pinned+'">'+(p.pinned?'Unpin':'Pin to top')+'</button><button type="button" class="alt" data-action="hide-post" data-hidden="'+!p.hidden+'">'+(p.hidden?'Show':'Hide')+'</button>':'')+'<button type="button" class="alt" data-action="delete-post">Delete post</button></div></section>':'');
}
function decisionsPage(){
  const q=(document.querySelector('#search')?.value||'').trim().toLowerCase();
  const match=m=>!q||JSON.stringify([m.title,m.notes,m.agenda.map(a=>a.label+' '+a.detail),m.actions.map(a=>a.title+' '+a.ownerName)]).toLowerCase().includes(q);
  const html=decisionsData.filter(match).map(m=>'<section class="panel"><p class="mono">'+esc(m.startsAt?new Date(m.startsAt).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric',timeZone:m.timezone}):m.schedule||'')+'</p><h2><a href="#'+m.id+'">'+esc(m.title)+'</a></h2>'+
    (m.agenda.length?'<h3>Agenda</h3><ol>'+m.agenda.map(a=>'<li>'+esc(a.label)+'</li>').join('')+'</ol>':'')+
    (m.notes?'<h3>Decisions and next steps</h3><div class="note">'+esc(m.notes)+'</div>':'')+
    (m.actions.length?'<h3>Action items</h3><ul class="subs">'+m.actions.map(a=>actionRow(a)).join('')+'</ul>':'')+'</section>').join('');
  const results=document.querySelector('#results');
  if(results){results.innerHTML=html||'<p class="muted">Nothing matches.</p>';return;}
  root.innerHTML=hero('Decisions','Past meetings: agendas, decisions and action items.')+
    '<label class="panel">Search<input id="search" type="search" placeholder="Search decisions, topics, people…"></label><div id="results">'+(html||'<p class="muted">No past meetings yet.</p>')+'</div>';
}

/* Loading and showing the current page */
function asMember(m){
  // What a regular member would get for this meeting.
  if(!preview||!m)return m;
  const counts=m.phase==='agenda';
  return {...m,admin:false,topics:m.topics.filter(t=>!t.hidden).map(t=>counts?t:{...t,up:null,down:null,votes:null}),
    attendance:{going:m.attendance.going,maybe:m.attendance.maybe}};
}
async function show(){
  if(!group.me&&route.page!=='meeting'){welcome();return;}
  if((route.page==='organize'||route.page==='members')&&!organizer()){location.hash='';return;}
  switch(route.page){
    case 'organize': group=await groupApi('',undefined,{view:'organize'}); header(); organize(); return;
    case 'members': members(); return;
    case 'decisions': decisionsData=(await groupApi('',undefined,{view:'decisions'})).decisions; decisionsPage(); return;
    case 'events': {const r=await eventsApi();eventKinds=r.kinds;eventList=preview?{upcoming:r.upcoming.filter(e=>!e.hidden),past:r.past.filter(e=>!e.hidden)}:r;eventsPage();return;}
    case 'event': {
      const r=await eventsApi('',undefined,{event:route.id});eventKinds=r.kinds;event=r.event;document.title=event.title+' · '+group.group;
      if(preview)event={...event,canEdit:false};
      const manageEvent=(route.manage||(organizer()&&!route.view))&&event.canEdit;
      route.manage=manageEvent;
      if(manageEvent)eventManage();else eventView();
      return;
    }
    case 'post': post=(await postsApi('',undefined,{post:route.id})).post; document.title=post.title+' · '+group.group; postPage(); return;
    case 'meeting': {
      meeting=asMember(await api());document.title=meeting.title+' · '+group.group;
      const manageMeeting=(route.manage||(organizer()&&!route.view))&&meeting.admin&&!preview;
      route.manage=manageMeeting;
      if(manageMeeting){if(!draft.length)draft=meeting.agenda.map(item=>({...item}));meetingManage();}
      else meetingView();
      return;
    }
    case 'me': postList=(await postsApi()).posts; dashboard(); return;
    default:
      if(organizer()){route.page='organize';group=await groupApi('',undefined,{view:'organize'});header();organize();return;}
      postList=(await postsApi()).posts; dashboard();
  }
}
async function load(){
  group=await groupApi();
  header();
  await show();
}
async function refresh(){
  if(route.page==='meeting'&&route.manage)readDraft();
  const keep=draft;
  if(route.page!=='meeting'&&route.page!=='event'&&route.page!=='post'){group=await groupApi();header();}
  await show();
  draft=keep;
  if(route.page==='meeting'&&route.manage)drawDraft();
}
async function perform(button,task){
  if(button)button.disabled=true;
  tell('');
  try{await task();}catch(error){tell(error.message);}
  finally{if(button?.isConnected)button.disabled=false;}
}

document.addEventListener('click',event=>{
  const button=event.target.closest('button[data-action="preview"]');
  if(!button)return;
  setPreview(!preview);
  location.reload();
});
root.addEventListener('input',event=>{if(event.target.id==='search')decisionsPage();});
root.addEventListener('change',event=>{
  if(event.target.name==='status'&&event.target.closest('[data-form=rsvp]')){
    const reason=root.querySelector('[data-reason]');
    if(reason)reason.hidden=event.target.value==='yes';
  }
});
root.addEventListener('submit',ev=>{
  ev.preventDefault();
  const form=ev.target, data=new FormData(form), fields=Object.fromEntries(data), kind=form.dataset.form;
  perform(ev.submitter,async()=>{
    let result={};
    switch(kind){
      case 'signin': result=await groupApi('signin',{email:fields.email}); form.reset(); tell(result.notice); return;
      case 'join': result=await groupApi('join',fields); form.reset(); tell(result.notice); return;
      case 'setup': await groupApi('setup',fields); location.href='/'; return;
      case 'profile': await groupApi('profile',{name:fields.name,emails:fields.email==='none'?'none':'all',digest:fields.email==='none'?undefined:fields.email}); await refresh(); tell('Settings saved.'); return;
      case 'add-members': result=await groupApi('add',{people:fields.people,role:data.has('organizer')?'organizer':'member'}); await refresh(); tell(result.notice); return;
      case 'promote': result=await groupApi('role',{member:fields.member,role:'organizer'}); await refresh(); tell(result.notice); return;
      case 'post': {const created=await postsApi('create',fields); location.hash='post/'+created.id; return;}
      case 'comment': await postsApi('comment',{kind:form.dataset.kind,target:form.dataset.target,body:fields.body}); await refresh(); tell('Reply posted.'); return;
      case 'new-meeting': {const created=await api('',fields,''); location.hash=created.id+'/manage'; return;}
      case 'event-create': case 'event-update': {
        const payload={...fields,duration:minutesBetween(fields.local,fields.ends)||undefined};
        if(kind==='event-create'){const created=await eventsApi('create',payload);location.hash='event/'+created.id+'/manage';return;}
        await eventsApi('update',{...payload,event:route.id}); await refresh(); tell('Saved.'); return;
      }
      case 'slot-add': await eventsApi('slot-add',{...fields,event:route.id}); await refresh(); tell('Slot added.'); return;
      case 'rsvp': result=await api('rsvp',{status:fields.status,reason:fields.reason}); break;
      case 'action-add': result=await api('action-add',fields); break;
      case 'carry': result=await api('carry',{to:fields.to}); break;
      case 'topic': result=await api('topic',fields); break;
      case 'topic-edit': result=await api('topic-edit',{topic:form.dataset.topic,...fields}); editing=''; break;
      case 'schedule': result=await api('schedule',{...fields,notify:data.has('notify')}); break;
      case 'agenda': readDraft(); result=await api('agenda',{agenda:draft}); draft=[]; break;
      case 'notes': result=await api('notes',{notes:fields.notes}); break;
    }
    await refresh();
    tell([{'action-add':'Action item added.',carry:'',rsvp:'RSVP saved.',topic:'Topic submitted.','topic-edit':'Topic saved.',schedule:'Details saved.',agenda:'Agenda published.',notes:'Outcomes saved.'}[kind],result.notice].filter(Boolean).join(' '));
  });
});
root.addEventListener('click',ev=>{
  const button=ev.target.closest('button[data-action]');
  if(!button||button.dataset.action==='preview')return;
  const action=button.dataset.action, d=button.dataset;
  perform(button,async()=>{
    if(action==='signout'){setPreview(false);await groupApi('signout',{});location.href='/';return;}
    if(action==='copy'){const f=document.querySelector(d.target);f.select();try{await navigator.clipboard.writeText(f.value);tell('Link copied.');}catch{tell('Link selected. Copy it from the field.');}return;}
    if(action==='feed'){
      if(group.feedUrl&&!confirm('Make a new link? The old one will stop working in calendars that use it.'))return;
      group.feedUrl=(await groupApi('feed',{})).feedUrl;dashboard();tell('Your calendar link is ready.');return;
    }
    if(['approve','decline','role','remove-member'].includes(action)){
      if(action==='remove-member'&&!confirm('Remove '+d.name+' from the group?'))return;
      if(action==='role'&&d.role==='member'&&d.member===group.me.id&&!confirm('Step down as organizer? You’ll lose access to the organizer panel.'))return;
      const result=await groupApi(action==='remove-member'?'remove':action,{member:d.member,role:d.role});
      if(action==='role'&&d.member===group.me.id){location.href='/';return;}
      await refresh(); tell(result.notice); return;
    }
    if(action==='delete-comment'){if(!confirm('Delete this comment?'))return;await postsApi('delete-comment',{comment:d.comment});await refresh();tell('Comment deleted.');return;}
    if(action==='delete-post'){if(!confirm('Delete this post and its replies?'))return;await postsApi('delete',{post:route.id});location.href='/';return;}
    if(action==='pin-post'||action==='hide-post'){await postsApi(action==='pin-post'?'pin':'hide',{post:route.id,pinned:d.pinned==='true',hidden:d.hidden==='true'});await refresh();tell('Saved.');return;}
    if(action==='claim'||action==='unclaim'){await eventsApi(action,{slot:d.slot});await refresh();tell(action==='claim'?'You’re signed up. You’ll get a reminder the day before.':'You’re off that slot.');return;}
    if(action==='remove-claim'){if(!confirm('Take this person off the slot?'))return;await eventsApi('remove-claim',{event:route.id,slot:d.slot,member:d.member});await refresh();tell('Removed.');return;}
    if(action==='slot-delete'){if(!confirm('Delete this slot and its sign-ups?'))return;await eventsApi('slot-delete',{event:route.id,slot:d.slot});await refresh();tell('Slot deleted.');return;}
    if(action==='event-announce'||action==='event-help'){const r=await eventsApi(action==='event-announce'?'announce':'help',{event:route.id});await refresh();tell(r.notice);return;}
    if(action==='event-hide'){await eventsApi('hide',{event:route.id,hidden:d.hidden==='true'});await refresh();tell('Saved.');return;}
    if(action==='event-delete'){
      if(!confirm('Delete “'+event.title+'”? Its sign-up slots and discussion will be removed. This can’t be undone.'))return;
      await eventsApi('delete',{event:route.id,notify:!!document.querySelector('#notify-cancel')?.checked});location.hash='events';return;
    }
    if(action==='action-done'){
      await call('/api/meeting',{meeting:d.meeting,action:'action-done'},{action:d.item,done:d.done==='true'});
      await refresh(); tell(d.done==='true'?'Marked done.':'Reopened.'); return;
    }
    if(action==='action-delete'){if(!confirm('Delete this action item?'))return;await api('action-delete',{action:d.item});await refresh();tell('Deleted.');return;}
    if(action==='edit-topic'||action==='cancel-edit'){readDraft();editing=action==='edit-topic'?d.topic:'';meetingManage();return;}
    if(action==='hide-topic'){await api('topic-hide',{topic:d.topic,hidden:d.hidden==='true'});await refresh();tell(d.hidden==='true'?'Topic hidden. Members no longer see it.':'Topic visible again.');return;}
    if(action==='delete-topic'){if(!confirm('Delete this topic and its votes? This can’t be undone.'))return;await api('topic-delete',{topic:d.topic});await refresh();tell('Topic deleted.');return;}
    if(action==='cast'){
      const value=Number(d.value), current=meeting.topics.find(t=>t.id===d.topic)?.mine;
      await api('vote',{topic:d.topic,value:current===value?0:value});
      await refresh(); tell(current===value?'Vote removed.':'Vote saved.'); return;
    }
    if(action==='nudge'){const r=await api('nudge',{});tell(r.notice);return;}
    if(action==='delete-meeting'){
      if(!confirm('Delete “'+meeting.title+'”? Its topics, votes, RSVPs, action items and discussion will be removed. This can’t be undone.'))return;
      const r=await api('delete',{notify:!!document.querySelector('#notify-cancel')?.checked});
      location.hash='';tell(r.notice);return;
    }
    if(action==='mail-agenda'||action==='mail-outcomes'){const r=await api('email',{kind:action.slice(5)});tell(r.notice);return;}
    readDraft();
    if(action==='collect'||action==='phase-vote'){
      const phase=action==='collect'?'collect':'vote';
      const r=await api('phase',{phase});
      await refresh();
      tell([phase==='vote'?'Submissions closed. Final vote is open.':'Submissions are open.',r.notice].filter(Boolean).join(' '));
      return;
    }
    const i=Number(d.index);
    if(action==='suggest'){
      if(draft.length&&!confirm('Replace the current draft with the three highest-ranked topics?'))return;
      draft=meeting.topics.filter(t=>!t.hidden).slice(0,3).map(item=>({label:item.label,detail:item.detail,kind:item.kind,minutes:15}));
    }
    if(action==='add'&&draft.length<15)draft.push({label:'',detail:'',kind:'Discussion',minutes:10});
    if(action==='add-actions'&&draft.length<15)draft.push({label:'Review open action items',kind:'Update',minutes:10,
      detail:meeting.openActions.map(a=>'• '+a.title+(a.ownerName?' ('+a.ownerName+')':'')+(a.due?', due '+dueText(a.due):'')).join('\n').slice(0,650)});
    if(action==='remove')draft.splice(i,1);
    if(action==='up')[draft[i-1],draft[i]]=[draft[i],draft[i-1]];
    drawDraft();
  });
});
window.addEventListener('hashchange',()=>location.reload());
load().catch(error=>{root.innerHTML=hero('Not available','Check the link, or go back to the start.')+'<p><a href="/">← Start</a></p>';tell(error.message);});
