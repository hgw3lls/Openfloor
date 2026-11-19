/* Tower Press: member pages, a separate organizer panel, and "preview as member". */
const root=document.querySelector('#app'), status=document.querySelector('#status'), nav=document.querySelector('#nav'), banner=document.querySelector('#banner'), tabs=document.querySelector('#tabs');
const isId=v=>/^[a-f0-9-]{36}$/.test(v||'');
const parts=location.hash.slice(1).split('/');
const route={page:'home'};
// Organizers get the organizer version of a page by default; '/view' (or preview) shows the member version.
if(isId(parts[0])){route.page='meeting';route.id=parts[0];if(parts[1]==='manage')route.manage=true;else if(parts[1]==='view')route.view=true;else if(isId(parts[1])){route.secret=parts[1];route.manage=true;}}
else if(parts[0]==='event'&&isId(parts[1])){route.page='event';route.id=parts[1];route.manage=parts[2]==='manage';route.view=parts[2]==='view';}
else if(parts[0]==='post'&&isId(parts[1])){route.page='post';route.id=parts[1];}
else if(parts[0]==='call'&&isId(parts[1])){route.page='call';route.id=parts[1];}
else if(parts[0]==='proposal'&&isId(parts[1])){route.page='proposal';route.id=parts[1];}
else if(['organize','members','decisions','events','me','calls','meetings','board','settings','group'].includes(parts[0]))route.page=parts[0];

const categories=['Discussion','Decision','Update'];
const repeatLabels={'':'Does not repeat',weekly:'Every week',biweekly:'Every two weeks',monthly:'Every month (same weekday)'};
const rsvpLabels={yes:'Going',maybe:'Maybe',no:'Can’t make it'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const para=text=>esc(text).replace(/\n/g,'<br>');
const trap='<label class="trap" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>';
const options=selected=>categories.map(kind=>'<option'+(selected===kind?' selected':'')+'>'+kind+'</option>').join('');
let tellTimer;
const tell=message=>{status.textContent=message||'';clearTimeout(tellTimer);if(message&&document.body.classList.contains('night'))tellTimer=setTimeout(()=>status.textContent='',4000);};
const zone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
const zones=()=>{try{return Intl.supportedValuesOf('timeZone');}catch{return ['UTC'];}};
const zoneSelect=selected=>{const list=zones();if(!list.includes(selected))list.unshift(selected);return '<select name="timezone">'+list.map(z=>'<option'+(z===selected?' selected':'')+'>'+esc(z)+'</option>').join('')+'</select>';};
const repeatSelect=selected=>'<select name="repeat">'+Object.entries(repeatLabels).map(([v,l])=>'<option value="'+v+'"'+(v===(selected||'')?' selected':'')+'>'+l+'</option>').join('')+'</select>';
const dueText=d=>d?new Date(d+'T12:00:00Z').toLocaleDateString(undefined,{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}):'';
const overdue=a=>a.status==='open'&&a.due&&a.due<new Date().toISOString().slice(0,10);
const ago=ms=>{const m=Math.round((Date.now()-ms)/60000);return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'});};

let call, callList={open:[],closed:[]}, callKinds=[], callFilter='', group, meeting, event, eventKinds=[], post, postList=[], eventList={upcoming:[],past:[]}, decisionsData=[], draft=[], editing='';

/* Preview as member: organizers see pages exactly as members do. */
let preview=false;
try{preview=localStorage.getItem('tp-preview')==='1';}catch{}
const setPreview=on=>{try{on?localStorage.setItem('tp-preview','1'):localStorage.removeItem('tp-preview');}catch{}};
const realOrganizer=()=>group?.me?.role==='organizer';
const organizer=()=>realOrganizer()&&!preview;
// What members can do with each feature: full, view or off. Organizers get everything (unless previewing).
const lvl=key=>organizer()?'full':group?.features?.[key]||'full';
const can=key=>lvl(key)==='full', shown=key=>lvl(key)!=='off';

async function request(path,params,payload){
  const headers={};
  if(route.secret&&path==='/api/meeting')headers.Authorization='Bearer '+route.secret;
  if(payload!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(path+'?'+new URLSearchParams(params),{method:payload===undefined?'GET':'POST',headers,body:payload===undefined?undefined:JSON.stringify(payload)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error);
  return data;
}
const api=(action='',payload,meetingId=route.id||meeting?.id)=>request('/api/meeting',{meeting:meetingId||'',action},payload);
const groupApi=(action='',payload,params={})=>request('/api/group',{action,...params},payload);
const postsApi=(action='',payload,params={})=>request('/api/posts',{action,...params},payload);
const eventsApi=(action='',payload,params={})=>request('/api/events',{action,...params},payload);
const callsApi=(action='',payload,params={})=>request('/api/calls',{action,...params},payload);
const proposalsApi=(action='',payload,params={})=>request('/api/proposals',{action,...params},payload);

function hero(title,subtitle,badge='',extra=''){
  return '<section class="hero">'+(badge?'<span class="mono phase">'+badge+'</span>':'')+'<h1>'+esc(title)+'</h1>'+(subtitle?'<p>'+esc(subtitle)+'</p>':'')+extra+'</section>';
}
function header(){
  const me=group?.me;
  if(!me){nav.innerHTML='<a href="/">Sign in</a>';banner.innerHTML='';tabs.innerHTML='';return;}
  const link=(href,label,page,dup)=>'<a href="'+href+'" class="'+(route.page===page?'on':'')+(dup?' dup':'')+'">'+label+'</a>';
  const wallHref=organizer()?'#me':'/', onWall=organizer()?route.page==='me':route.page==='home'||route.page==='me';
  const home=(organizer()?link('/','Organizer',route.page==='organize'?'organize':'home'):'')+link(wallHref,'Wall',onWall?route.page:'-','dup')+link('#meetings','Meetings','meetings','dup');
  nav.innerHTML=home+(shown('events')?link('#events','Events','events',1):'')+(shown('calls')?link('#calls','Calls','calls',1):'')+(shown('posts')?link('#board','Board','board'):'')+link('#decisions','Decisions','decisions')+
    '<span class="who">'+esc(me.name||me.email)+'</span>'+
    (realOrganizer()?'<button type="button" class="alt" data-action="preview">'+(preview?'Exit preview':'Preview as member')+'</button>':'');
  const tab=(href,label,on)=>'<a href="'+href+'"'+(on?' class="on" aria-current="page"':'')+'>'+label+'</a>';
  tabs.innerHTML=tab(wallHref,'Wall',onWall)+tab('#meetings','Meetings',route.page==='meetings'||route.page==='meeting')+(shown('events')?tab('#events','Events',route.page==='events'||route.page==='event'):'')+(shown('calls')?tab('#calls','Calls',route.page==='calls'||route.page==='call'):'');
  tabs.style.gridTemplateColumns='repeat('+tabs.children.length+',1fr)';
  banner.innerHTML=preview?'You’re previewing the site as a regular member. <button type="button" data-action="preview">Exit preview</button>':'';
}
function orgbar(label,href){
  return organizer()?'<div class="orgbar"><strong>Organizer</strong><a class="button" href="'+href+'">'+label+'</a><span class="muted">Members see this page without these controls.</span></div>':'';
}
function comments(list,{kind,target,form=true,small=false}={}){
  form=form&&can('comments');
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
/* Member dashboard */
function meetingCard(m){
  const chip=m.mine?'<span class="chip rsvp-'+m.mine+'">'+rsvpLabels[m.mine]+'</span>':(m.past?'':'<span class="chip todo">RSVP needed</span>');
  return '<a class="card" href="#'+m.id+(organizer()?'/view':'')+'"><strong>'+esc(m.title)+'</strong><span class="muted">'+esc(m.when||'Date to be set')+(m.location?' · '+esc(m.location):'')+'</span><span class="mono">'+chip+(m.going?'<span>'+m.going+' going</span>':'')+'</span></a>';
}
function eventCard(e){
  const open=e.spots-e.taken;
  return '<a class="card" href="#event/'+e.id+(organizer()&&route.page!=='events'?'/view':'')+'"><span class="mono"><span class="tag">'+esc(e.kind)+'</span>'+(e.signedUp?'<span class="chip rsvp-yes">You’re helping</span>':'')+(open>0?'<span class="chip todo">'+open+(open===1?' spot':' spots')+' open</span>':'')+(e.hidden?'<span>hidden</span>':'')+'</span><strong>'+esc(e.title)+'</strong><span class="muted">'+esc(e.when)+(e.location?' · '+esc(e.location):'')+'</span></a>';
}
/* Save to the phone's home screen */
let installPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;document.querySelector('[data-action=install]')?.removeAttribute('hidden');});
const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
function installPanel(){
  let dismissed=false;try{dismissed=localStorage.getItem('tp-install')==='no';}catch{}
  if(standalone()||dismissed)return '';
  const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  return '<section class="panel"><h2>Add to your phone</h2><p class="muted">Save '+esc(group.group)+' to your home screen and it opens like an app.</p>'+
    (ios?'<ol><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button (the square with an arrow).</li><li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li><li>Open it from your home screen and sign in once. Ask for a sign-in email and type the 6-digit code from it.</li></ol>'
      :'<p><button type="button" data-action="install"'+(installPrompt?'':' hidden')+'>Install the app</button></p><p class="muted">No button? In Chrome, open the <strong>⋮</strong> menu and choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</p>')+
    '<p><button type="button" class="link" data-action="install-dismiss">Don’t show this again</button></p></section>';
}
function codeForm(email){
  return '<form class="panel" data-form="code"><h2>Check your email</h2><p class="muted">Tap the link in the email, or type the 6-digit code from it here.</p><input type="hidden" name="email" value="'+esc(email)+'"><label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></label><button>Sign in</button></form>';
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
    organizersPanel()+featuresPanel()+
    '<section class="panel"><h2>Quick links</h2><div class="actions"><a class="button alt" href="#members">Members and invitations</a><a class="button alt" href="#events">Events and sign-ups</a><a class="button alt" href="#decisions">Decisions</a></div>'+
      '<h3>Download</h3><div class="actions"><a class="button alt" href="/api/export?what=members">Members</a><a class="button alt" href="/api/export?what=meetings">Meetings and outcomes</a><a class="button alt" href="/api/export?what=attendance">Attendance</a></div></section>'+
    '<section class="panel"><h2>Email</h2><p>'+e.sent_today+' sent in the last 24 hours (limit '+e.limit+') · '+e.waiting+' waiting · '+e.retrying+' being retried · '+e.failed+' failed</p><p class="muted">Email replies last checked '+esc(checked)+'. '+m.no_email+(m.no_email===1?' member has':' members have')+' email turned off.</p></section>'+
    '<section class="panel"><h2>See it as a member</h2><p class="muted">Preview shows every page exactly as a regular member sees it: no vote counts before the agenda, no hidden topics, no organizer tools.</p><button type="button" data-action="preview">Preview as member</button></section>';
}
function featuresPanel(){
  const list=group.featureList||[], now=group.features||{};
  const pick=(f,v,label)=>'<label class="pick"><input type="radio" name="'+f.key+'" value="'+v+'"'+((now[f.key]||'full')===v?' checked':'')+'> <span><strong>'+label+'</strong><br><span class="muted">'+esc(f[v])+'</span></span></label>';
  return '<section class="panel"><h2>What members can use</h2><p class="muted">Turn features off, or make them view-only, for everyone who isn’t an organizer. Organizers always have everything. RSVPs and action items are always on. Use <strong>Preview as member</strong> to check the result.</p>'+
    '<form data-form="features">'+list.map(f=>'<fieldset class="stack"><legend>'+esc(f.label)+'</legend><div class="levels">'+pick(f,'full','On')+pick(f,'view','View only')+pick(f,'off','Off')+'</div></fieldset>').join('')+'<button>Save</button></form></section>';
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
     (m.status==='active'?'<button type="button" class="alt small" data-action="member-title" data-member="'+m.id+'" data-title="'+esc(m.title||'')+'">'+(m.title?'Role: '+esc(m.title):'Set role')+'</button>':'')+
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
  const votes=!manage&&open&&meeting.me&&can('topics')&&!item.own&&!item.hidden?'<div class="votes"><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="1" aria-pressed="'+(item.mine>0)+'" aria-label="Vote up: '+esc(item.label)+'">👍 Up</button><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="-1" aria-pressed="'+(item.mine<0)+'" aria-label="Vote down: '+esc(item.label)+'">👎 Down</button></div>':'';
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
function slotRow(s,{manage=false}={}){
  const full=s.taken>=s.capacity, people=s.people.map(p=>p.name);
  return '<div class="slot"><span><strong>'+esc(s.label)+'</strong>'+(s.when?'<br><span class="who">'+esc(s.when)+'</span>':'')+'<br><span class="who">'+s.taken+' of '+s.capacity+(people.length?': '+esc(people.join(', ')):'')+'</span></span><span class="actions">'+
    (manage?s.people.map(p=>'<button type="button" class="alt small" data-action="remove-claim" data-slot="'+s.id+'" data-member="'+p.id+'">Remove '+esc(p.name)+'</button>').join('')+'<button type="button" class="alt small" data-action="slot-delete" data-slot="'+s.id+'">Delete slot</button>':
      event.past||!can('signups')?'':s.mine?'<button type="button" class="alt small" data-action="unclaim" data-slot="'+s.id+'">Drop out</button>':full?'<span class="full">Full</span>':'<button type="button" class="small" data-action="claim" data-slot="'+s.id+'">Sign me up</button>')+'</span></div>';
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

/* Open calls */
const interestLabels={interested:'Interested',applying:'Applying',applied:'Applied'};
const daysLeft=d=>Math.round((Date.parse(d+'T00:00:00Z')-Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z'))/86400000);
function callCard(c){
  const left=daysLeft(c.deadline);
  const soon=left<0?'closed':left===0?'due today':left===1?'1 day left':left+' days left';
  return '<a class="card" href="#call/'+c.id+'"><span class="mono"><span class="tag">'+esc(c.kind)+'</span>'+(c.myStatus?'<span class="chip rsvp-yes">'+interestLabels[c.myStatus]+'</span>':'')+(left>=0&&left<=7?'<span class="chip todo">'+soon+'</span>':'')+(c.hidden?'<span>hidden</span>':'')+'</span><strong>'+esc(c.title)+'</strong><span class="muted">'+esc([c.organization,'Deadline '+dueText(c.deadline)+(left>7?' ('+soon+')':''),c.award].filter(Boolean).join(' · '))+(c.applying?' · '+c.applying+' from the group applying':'')+'</span></a>';
}
function callFields(c={}){
  return '<label>Name<input name="title" required maxlength="160" value="'+esc(c.title||'')+'" placeholder="Spring printmaking residency"></label>'+
    '<div class="row"><label>Type<select name="kind">'+callKinds.map(k=>'<option'+((c.kind||'Other')===k?' selected':'')+'>'+k+'</option>').join('')+'</select></label><label>Deadline<input type="date" name="deadline" required value="'+esc(c.deadline||'')+'"></label></div>'+
    '<div class="row"><label>Offered by<input name="organization" maxlength="160" value="'+esc(c.organization||'')+'" placeholder="Arts council, gallery…"></label><label>Fee or award <small>(optional)</small><input name="award" maxlength="160" value="'+esc(c.award||'')+'" placeholder="$2,000 · free to apply"></label></div>'+
    '<label>Link<input name="link" maxlength="500" value="'+esc(c.link||'')+'" placeholder="https://"></label><label>Details<textarea name="details" maxlength="5000">'+esc(c.details||'')+'</textarea></label>';
}
/* Posts and decisions */
/* Loading and showing the current page */
function asMember(m){
  // What a regular member would get for this meeting.
  if(!preview||!m)return m;
  const counts=m.phase==='agenda';
  return {...m,admin:false,topics:m.topics.filter(t=>!t.hidden).map(t=>counts?t:{...t,up:null,down:null,votes:null}),
    attendance:{going:m.attendance.going,maybe:m.attendance.maybe}};
}
/* The wall: the member home screen ("Night index"). A — Needs you, B — Pinned, C — Index. */
let wallDeck=[], wallAt=0, wallReason=false, wallSheet=null, wallDone=new Set();
let wallMine=false;try{wallMine=localStorage.getItem('tp-mine')==='1';}catch{}
const dismissed=()=>{try{return JSON.parse(localStorage.getItem('tp-dismissed')||'[]');}catch{return [];}};
const dismiss=key=>{try{localStorage.setItem('tp-dismissed',JSON.stringify([...dismissed(),key].slice(-200)));}catch{}};
const pad2=n=>String(n).padStart(2,'0');
const dayKey=d=>d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
const dowShort=d=>d.toLocaleDateString('en-GB',{weekday:'short'});
const monShort=d=>d.toLocaleDateString('en-GB',{month:'short'});
const clock=d=>d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
const deadlineDate=s=>new Date(s+'T12:00:00');
const daysUntil=s=>Math.round((Date.parse(s+'T00:00:00Z')-Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z'))/86400000);
const initials=me=>(me.name||me.email).split(/[\s@._-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'?';
function isoWeek(d){const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-day);const y=new Date(Date.UTC(t.getUTCFullYear(),0,1));return Math.ceil(((t-y)/86400000+1)/7);}
const peopleText=s=>s.people.length?esc(s.people.join(', '))+' · '+s.people.length+' of '+s.capacity:'Nobody yet · 0 of '+s.capacity;

// A — the decisions waiting for this member, in a fixed order for this visit.
function buildDeck(){
  const skip=new Set(dismissed()), deck=[];
  for(const m of group.meetings.upcoming.filter(m=>!m.mine&&m.startsAt))
    deck.push({key:'m:'+m.id,type:'rsvp',id:m.id,kind:'Meeting · '+dueLike(m.startsAt),title:m.title,
      detail:[clock(new Date(m.startsAt))+(m.location?' at '+m.location:''),m.going+' going'+(m.topics?', '+m.topics+(m.topics===1?' topic':' topics')+' on the table':'')].join('. ')+'.',
      choices:[['yes','Going'],['maybe','Maybe'],['no','Can’t make it']]});
  const topics=group.topics||[];
  topics.forEach((t,i)=>deck.push({key:'t:'+t.id,type:'vote',id:t.id,meeting:t.meeting,kind:'Topic vote · '+(i+1)+' of '+topics.length,title:t.label,
    detail:(t.detail?t.detail+' ':'')+'For '+t.meetingTitle+'. Make time for it?',choices:[['1','Yes, discuss'],['-1','Not now']]}));
  if(can('signups'))for(const s of (group.slots||[]).filter(s=>!s.mine&&s.people.length<s.capacity&&!skip.has('s:'+s.id)).slice(0,3)){
    const need=s.capacity-s.people.length;
    deck.push({key:'s:'+s.id,type:'slot',id:s.id,kind:'Help wanted · '+dueLike(s.startsAt),title:s.label+' · '+s.eventTitle,
      detail:(s.timed?s.when+'. ':'')+(s.people.length?s.people.join(', ')+' signed up, '+need+' more needed.':'Nobody yet, '+need+' needed.'),choices:[['claim','Sign me up'],['skip','Not this time']]});
  }
  if(can('proposals')){
    for(const p of (group.proposals?.open||[]).filter(p=>!p.myVote))
      deck.push({key:'p:'+p.id,type:'pvote',id:p.id,kind:'Vote · P-'+p.number+' · closes '+closesLabel(p.closesAt),title:p.title,
        detail:[p.figure,p.summary].filter(Boolean).join(' — ').slice(0,160)||'Proposed by '+p.author+'.',choices:[['for','For'],['against','Against'],['abstain','Abstain']]});
    for(const p of (group.proposals?.drafts||[]).filter(p=>!p.mine&&!skip.has('d:'+p.id)))
      deck.push({key:'d:'+p.id,type:'second',id:p.id,kind:'Proposal · needs a seconder',title:p.title,detail:'Proposed by '+(p.author||'a member')+'. Seconding opens it for everyone to vote.',choices:[['second','Second it'],['skip','Not now']]});
  }
  if(can('calls'))for(const c of (group.openCalls||[]).filter(c=>!c.myStatus&&!skip.has('c:'+c.id)).slice(0,3)){
    const left=daysUntil(c.deadline);
    deck.push({key:'c:'+c.id,type:'call',id:c.id,kind:'Open call · '+(left===0?'due today':left===1?'1 day left':left+' days left'),title:c.title,
      detail:[c.organization,c.award].filter(Boolean).join(', ')+(c.organization||c.award?'. ':'')+(c.applying?c.applying+' from the group applying.':'Nobody from the group is on it yet.'),
      choices:[['interested','I’m interested'],['skip','Not for me']]});
  }
  return deck;
}
const dueLike=iso=>{const d=new Date(iso);return dowShort(d)+' '+d.getDate()+' '+monShort(d);};

function deckHtml(){
  const n=wallDeck.length, left=Math.max(0,n-wallAt);
  const bars=n?'<div class="w-bars" style="grid-template-columns:repeat('+n+',1fr)">'+wallDeck.map((_,i)=>'<span class="'+(i<wallAt?'done':i===wallAt?'now':'')+'"></span>').join('')+'</div>':'';
  const head='<div class="w-label"><span>A — Needs you</span><span class="lime">'+(left?left+' waiting for you':'Done for now')+'</span></div>'+bars;
  if(!left)return head+'<div class="w-empty"><span>All caught up.</span><button type="button" data-action="w-redo">Redo</button></div>';
  const c=wallDeck[wallAt];
  const body=wallReason
    ?'<form class="w-reason" data-form="w-reason"><label>Why can’t you make it? <small>(only organizers see this)</small><textarea name="reason" required maxlength="500" rows="2"></textarea></label><div class="w-choices"><button class="fill">Send</button><button type="button" data-action="w-reason-cancel">Cancel</button></div></form>'
    :'<div class="w-choices">'+c.choices.map(([v,l],i)=>'<button type="button" class="'+(i===0?'fill':'')+'" data-action="w-choose" data-value="'+v+'">'+esc(l)+'</button>').join('')+'</div>';
  return head+'<div class="w-deck"><div class="w-behind"></div><div class="w-card" id="w-card"><span class="tape"></span><span class="eyebrow">'+esc(c.kind)+'</span><span class="w-title">'+esc(c.title)+'</span><span class="w-detail">'+esc(c.detail)+'</span>'+body+
    '<div class="w-nav"><button type="button" data-action="w-back"'+(wallAt?'':' class="dim"')+'>← Back</button><button type="button" class="purple" data-action="w-skip">Skip →</button></div></div></div>';
}

function pinnedHtml(){
  const m=group.meetings.upcoming.find(x=>x.startsAt), e=shown('events')?(group.upcomingEvents||[])[0]:null;
  const meetPoster=m?(()=>{const d=new Date(m.startsAt);return '<button type="button" class="w-poster meet" data-action="w-sheet" data-sheet="meet"><span class="tape"></span><span class="eyebrow lime">01 — Meeting</span><span class="num">'+pad2(d.getDate())+'<i>.</i>'+pad2(d.getMonth()+1)+'</span><span class="day">'+esc(dowShort(d)+' '+clock(d))+'</span><span class="chip">'+(m.mine?'You: '+rsvpLabels[m.mine]:'Tap to RSVP')+'</span></button>';})()
    :'<a class="w-poster meet" href="#meetings"><span class="eyebrow lime">01 — Meeting</span><span class="day">No meeting scheduled yet.</span></a>';
  let showPoster='';
  if(e){
    const words=e.title.split(/\s+/), last=words.pop();
    const slots=(group.slots||[]).filter(s=>s.event===e.id), mineS=slots.find(s=>s.mine), open=slots.find(s=>s.people.length<s.capacity);
    const state=mineS?'You: '+mineS.label:open?(open.people.length?esc(open.people.join(', '))+' · '+open.people.length+' of '+open.capacity:esc(open.label)+' · help wanted'):esc(e.when);
    showPoster='<button type="button" class="w-poster show" data-action="w-sheet" data-sheet="show"><span class="dot"></span><span class="eyebrow">02 — '+esc(e.kind)+'</span><span class="big">'+esc(words.join(' '))+(words.length?' ':'')+'<em>'+esc(last)+'</em></span><span class="state">'+state+'</span></button>';
  }else if(shown('events'))showPoster='<a class="w-poster show" href="#events"><span class="dot"></span><span class="eyebrow">02 — Events</span><span class="big">Nothing <em>yet</em></span><span class="state">'+(can('events')?'Add an event →':'See events →')+'</span></a>';
  return '<div class="w-label pad">B — Pinned</div><div class="w-pinned">'+meetPoster+showPoster+'</div>';
}

function indexItems(){
  const items=[];
  for(const m of group.meetings.upcoming){
    if(!m.startsAt)continue;
    const d=new Date(m.startsAt);
    items.push({date:d,kind:'Meeting',title:m.title,href:'#'+m.id+(organizer()?'/view':''),meta:[clock(d),m.location,m.going+' going'].filter(Boolean).join(' · '),mine:!!m.mine&&m.mine!=='no',
      act:m.mine?'You: '+rsvpLabels[m.mine]:'I’m going',on:!!m.mine,action:m.mine?'w-sheet':'w-rsvp',data:m.mine?{sheet:'meet',meeting:m.id}:{meeting:m.id}});
  }
  if(shown('events'))for(const e of group.upcomingEvents||[]){
    const d=new Date(e.startsAt);
    items.push({date:d,kind:e.kind==='Event'?'Event':'Event · '+e.kind,title:e.title,href:'#event/'+e.id+(organizer()?'/view':''),meta:[clock(d),e.location,e.goingCount?e.goingCount+' going':''].filter(Boolean).join(' · '),mine:e.signedUp||e.mine||e.going,
      ...(can('events')?{act:e.going?'Going ✓':'I’m going',on:e.going,action:'n-going',data:{event:e.id,going:String(!e.going)}}:{})});
    for(const s of (group.slots||[]).filter(s=>s.event===e.id)){
      const full=s.people.length>=s.capacity;
      items.push({date:new Date(s.startsAt),kind:'Sign-up',title:s.label,href:'#event/'+e.id+(organizer()?'/view':''),meta:peopleText(s),mine:s.mine,raw:true,
        ...(can('signups')&&(s.mine||!full)?{act:s.mine?'Signed up ✓':'Sign me up',on:s.mine,action:s.mine?'w-unclaim':'w-claim',data:{slot:s.id}}:{})});
    }
  }
  if(shown('calls'))for(const c of group.openCalls||[]){
    const toggle=can('calls')&&(!c.myStatus||c.myStatus==='interested');
    items.push({date:deadlineDate(c.deadline),kind:'Deadline · '+c.kind,title:c.title,href:'#call/'+c.id,
      meta:c.myStatus?'You: '+interestLabels[c.myStatus]+(c.applying?' · '+c.applying+' from the group applying':''):[c.organization,c.award].filter(Boolean).join(' · ')||'Open call',mine:!!c.myStatus,
      ...(toggle?{act:c.myStatus?'Interested ✓':'I’m interested',on:!!c.myStatus,action:'w-interest',data:{call:c.id,status:c.myStatus?'none':'interested'}}:{})});
  }
  if(shown('proposals'))for(const p of group.proposals?.open||[])
    items.push({date:new Date(p.closesAt),kind:'Vote closes · P-'+p.number,title:p.title,href:'#proposal/'+p.id,meta:(p.myVote?'You: '+({for:'For',against:'Against',abstain:'Abstain'})[p.myVote]+' · ':'')+p.counts.for+' for · '+p.counts.against+' against'+(p.quorumMet?' · quorum met':''),mine:!!p.myVote||p.mine});
  for(const a of group.myActions||[]){
    const done=wallDone.has(a.id);
    items.push({date:a.due?deadlineDate(a.due):null,kind:'Action item',title:a.title,href:'#'+a.meeting+(organizer()?'/view':''),meta:(overdue(a)&&!done?'Overdue · ':'')+'From '+a.meetingTitle,mine:true,done,
      act:done?'Done ✓':'Mark done',on:done,action:'w-done',data:{item:a.id,meeting:a.meeting,done:String(!done)}});
  }
  return items;
}
function indexHtml(){
  const days=new Map(), nodate=[];
  for(const it of indexItems().filter(it=>!wallMine||it.mine).sort((a,b)=>(a.date??Infinity)-(b.date??Infinity))){
    if(!it.date){nodate.push(it);continue;}
    const k=dayKey(it.date);if(!days.has(k))days.set(k,{d:it.date,items:[]});days.get(k).items.push(it);
  }
  let n=0;
  const item=it=>'<div class="w-item"><span class="eyebrow lime">'+pad2(++n)+' — '+esc(it.kind)+'</span><a class="w-ititle'+(it.done?' struck':'')+'" href="'+it.href+'">'+esc(it.title)+'</a><span class="w-meta">'+(it.raw?it.meta:esc(it.meta))+'</span>'+
    (it.act?'<button type="button" class="w-act'+(it.on?' on':'')+'" data-action="'+it.action+'"'+Object.entries(it.data||{}).map(([k,v])=>' data-'+k+'="'+esc(v)+'"').join('')+'>'+esc(it.act)+'</button>':'')+'</div>';
  const row=(num,sub,items)=>'<div class="w-row"><div class="w-day"><span>'+num+'</span><span class="lime">'+sub+'</span></div><div class="w-items">'+items.map(item).join('')+'</div></div>';
  const rows=[...days.values()].map(g=>row(pad2(g.d.getDate()),esc(dowShort(g.d)+' '+monShort(g.d)),g.items)).join('')+(nodate.length?row('—','Any time',nodate):'');
  return '<div class="w-label pad rule"><span>C — Index</span><div class="w-seg" role="group" aria-label="Show"><button type="button" data-action="w-mine" data-mine="0" aria-pressed="'+!wallMine+'">All</button><button type="button" data-action="w-mine" data-mine="1" aria-pressed="'+wallMine+'">Mine</button></div></div>'+
    (rows||'<p class="w-none">'+(wallMine?'Nothing of yours coming up.':'Nothing coming up yet.')+'</p>');
}

function boardHtml(){
  if(!shown('posts'))return '';
  const list=postList.slice(0,3);
  return '<div class="w-label pad rule"><span>D — Board</span><a class="lime" href="#board">'+(can('posts')?'All posts, write one →':'All posts →')+'</a></div>'+
    (list.length?list.map(p=>'<a class="w-post" href="#post/'+p.id+'"><span class="eyebrow lime">'+(p.pinned?'Pinned · ':'')+esc(p.author)+' · '+ago(p.created)+'</span><strong>'+esc(p.title)+'</strong>'+(p.replies?'<span class="w-meta">'+p.replies+(p.replies===1?' reply':' replies')+'</span>':'')+'</a>').join(''):'<p class="w-none">No posts yet.</p>');
}

function sheetHtml(){
  if(!wallSheet)return '';
  let s;
  if(wallSheet.type==='meet'){
    const m=group.meetings.upcoming.find(x=>x.id===wallSheet.meeting)||group.meetings.upcoming.find(x=>x.startsAt);
    if(!m)return '';
    const d=new Date(m.startsAt);
    s={kind:'Meeting · '+dueLike(m.startsAt),title:'Can you make it?',body:[clock(d)+(m.location?', '+m.location:''),m.going+' going'].join('. ')+'.',
      opts:wallReason?'<form class="w-reason" data-form="w-sheet-reason"><label>Why can’t you make it? <small>(only organizers see this)</small><textarea name="reason" required maxlength="500" rows="2"></textarea></label><button class="w-opt on">Send</button></form>'
        :Object.entries(rsvpLabels).map(([k,l])=>'<button type="button" class="w-opt'+(m.mine===k?' on':'')+'" data-action="w-sheet-rsvp" data-meeting="'+m.id+'" data-value="'+k+'">'+l+'</button>').join(''),
      link:'<a href="#'+m.id+(organizer()?'/view':'')+'">Meeting page, topics and agenda →</a>'};
  }else{
    const e=(group.upcomingEvents||[])[0];
    if(!e)return '';
    const slots=(group.slots||[]).filter(x=>x.event===e.id);
    s={kind:e.kind+' · '+dueLike(e.startsAt),title:e.title,body:esc(e.when)+(e.location?', '+esc(e.location):'')+'.',
      opts:slots.length&&can('signups')?slots.map(x=>{const full=x.people.length>=x.capacity&&!x.mine;return '<button type="button" class="w-opt'+(x.mine?' on':'')+'" data-action="'+(x.mine?'w-unclaim':'w-claim')+'" data-slot="'+x.id+'"'+(full?' disabled':'')+'>'+esc(x.label)+' — '+(x.mine?'Signed up ✓':full?'Full':'Sign me up')+'</button>';}).join(''):'',
      link:'<a href="#event/'+e.id+(organizer()?'/view':'')+'">Event page →</a>'};
  }
  return '<button type="button" class="w-scrim" data-action="w-close" aria-label="Close"></button><div class="w-sheet" role="dialog" aria-modal="true" aria-label="'+esc(s.title)+'"><span class="tape"></span><span class="eyebrow">'+esc(s.kind)+'</span><span class="w-stitle">'+esc(s.title)+'</span><span class="w-sbody">'+s.body+'</span><div class="w-opts">'+s.opts+'</div><div class="w-sfoot">'+s.link+'<button type="button" data-action="w-close">Close ✕</button></div></div>';
}

function inTodayStrip(){
  const list=group.inToday||[], mine=list.some(p=>p.me), others=list.filter(p=>!p.me);
  return '<div class="n-intoday"><a href="#group"><span class="eyebrow lime">In the studio today</span><span>'+(list.length?esc(list.map(p=>p.me?'You':p.name).join(', ')):'Nobody yet')+'</span></a>'+
    '<button type="button" class="n-btn'+(mine?' on':'')+'" data-action="n-checkin" data-in="'+!mine+'" aria-pressed="'+mine+'">'+(mine?'In today ✓':'I’m in today')+'</button></div>';
}
function wall(){
  const me=group.me, now=new Date();
  document.body.classList.add('night');
  root.innerHTML='<div class="wall">'+
    '<div class="w-brand"><span class="w-mark">Tower Press <em>Artist Group</em></span><span class="w-right">'+(realOrganizer()&&!preview?'<a class="w-org" href="/">Organizer</a>':'')+'<a class="w-avatar" href="#settings" aria-label="Your settings">'+esc(initials(me))+'</a></span></div>'+
    '<div class="w-hero"><h1>On the<br><em>wall</em></h1><div class="w-date">'+esc(now.toLocaleDateString('en-GB',{weekday:'short'}).toUpperCase())+'<br>'+pad2(now.getDate())+'.'+pad2(now.getMonth()+1)+'.'+String(now.getFullYear()).slice(2)+'<br><span class="lime">WK '+isoWeek(now)+'</span></div></div>'+
    inTodayStrip()+
    '<section aria-label="Needs you" id="w-a">'+deckHtml()+'</section>'+
    '<section aria-label="Pinned">'+pinnedHtml()+'</section>'+
    '<section aria-label="Index">'+indexHtml()+'</section>'+
    '<section aria-label="Board">'+boardHtml()+'</section>'+
    '<div id="w-sheet">'+sheetHtml()+'</div></div>';
  if(wallSheet)root.querySelector('.w-sheet button, .w-sheet textarea')?.focus();
}
function wallStart(){wallDeck=buildDeck();wallAt=0;wallReason=false;wallSheet=null;wall();}
async function wallReload(){group=await groupApi();header();if(shown('posts'))postList=(await postsApi()).posts;wall();}
// Slide the answered card off, then show the next one.
async function wallNext(){
  const card=document.querySelector('#w-card');
  wallReason=false;
  if(card&&!matchMedia('(prefers-reduced-motion: reduce)').matches){card.classList.add('leaving');await new Promise(r=>setTimeout(r,240));}
  wallAt++;
  await wallReload();
  document.querySelector('#w-card')?.classList.add('entering');
}
async function wallAnswer(c,value,reason){
  if(c.type==='rsvp'){if(value==='no'&&!reason){wallReason=true;wall();document.querySelector('[data-form=w-reason] textarea')?.focus();return false;}await api('rsvp',{status:value,reason:reason||''},c.id);}
  else if(c.type==='vote')await api('vote',{topic:c.id,value:Number(value)},c.meeting);
  else if(value==='skip')dismiss(c.key);
  else if(c.type==='slot')await eventsApi('claim',{slot:c.id});
  else if(c.type==='pvote')await proposalsApi('vote',{proposal:c.id,vote:value});
  else if(c.type==='second')await proposalsApi('second',{proposal:c.id});
  else if(c.type==='call')await callsApi('interest',{call:c.id,status:'interested'});
  return true;
}
async function wallClick(action,d){
  if(action==='w-choose'){if(await wallAnswer(wallDeck[wallAt],d.value))await wallNext();return true;}
  if(action==='w-reason-cancel'){wallReason=false;wall();return true;}
  if(action==='w-skip'){wallAt=Math.min(wallDeck.length,wallAt+1);wallReason=false;wall();return true;}
  if(action==='w-back'){wallAt=Math.max(0,wallAt-1);wallReason=false;wall();return true;}
  if(action==='w-redo'){try{localStorage.removeItem('tp-dismissed');}catch{}await wallReload();wallStart();return true;}
  if(action==='w-mine'){wallMine=d.mine==='1';try{localStorage.setItem('tp-mine',wallMine?'1':'0');}catch{}wall();return true;}
  if(action==='w-sheet'){wallSheet={type:d.sheet,meeting:d.meeting};wallReason=false;wall();return true;}
  if(action==='w-close'){wallSheet=null;wallReason=false;wall();return true;}
  if(action==='w-sheet-rsvp'){
    if(d.value==='no'){wallReason=true;wallSheet.meeting=d.meeting;wall();return true;}
    await api('rsvp',{status:d.value,reason:''},d.meeting);await wallReload();tell('Saved: '+rsvpLabels[d.value]+'.');return true;
  }
  if(action==='w-rsvp'){await api('rsvp',{status:'yes',reason:''},d.meeting);await wallReload();tell('You’re going.');return true;}
  if(action==='w-claim'||action==='w-unclaim'){await eventsApi(action==='w-claim'?'claim':'unclaim',{slot:d.slot});if(document.querySelector('.wall:not(.night-page)'))await wallReload();else await refresh();tell(action==='w-claim'?'You’re signed up. You’ll get a reminder the day before.':'You’re off that slot.');return true;}
  if(action==='w-interest'){await callsApi('interest',{call:d.call,status:d.status});await wallReload();tell(d.status==='none'?'Cleared.':'Saved: Interested.');return true;}
  if(action==='w-done'){await request('/api/meeting',{meeting:d.meeting,action:'action-done'},{action:d.item,done:d.done==='true'});if(d.done==='true')wallDone.add(d.item);else wallDone.delete(d.item);wall();tell(d.done==='true'?'Marked done.':'Reopened.');return true;}
  return false;
}
async function wallSubmit(kind,fields){
  if(kind==='w-reason'){if(await wallAnswer(wallDeck[wallAt],'no',fields.reason))await wallNext();return true;}
  if(kind==='n-propose'){const r=await proposalsApi('create',fields);proposing=false;location.hash='proposal/'+r.id;return true;}
  if(kind==='n-proposal-update'){await proposalsApi('update',{...fields,proposal:route.id});await refresh();tell('Saved.');return true;}
  if(kind==='n-signin'){await groupApi('signin',{email:fields.email});signAddr=fields.email.trim();signStep='code';signCode='';welcome();tell('If that address is on the member list, a code is on its way.');return true;}
  if(kind==='n-rsvp-no'){await api('rsvp',{status:'no',reason:fields.reason},meeting.id);meeting.rsvpReason=false;await reloadMeeting();tell('Saved: Can’t make it.');return true;}
  if(kind==='w-sheet-reason'){await api('rsvp',{status:'no',reason:fields.reason},wallSheet.meeting);wallReason=false;await wallReload();tell('Saved: Can’t make it.');return true;}
  return false;
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&wallSheet&&document.body.classList.contains('night')){wallSheet=null;wallReason=false;wall();}});

/* Pages that used to live on the dashboard */
/* Night screens: every member page in the 5A "Night index" language. */
const nightPages=new Set(['proposal','home','me','meetings','meeting','events','event','calls','call','settings','group','board','post','decisions','welcome']);
function brandRow(){
  const me=group?.me;
  return '<div class="w-brand"><a class="w-mark" href="'+(organizer()?'#me':'/')+'">Tower Press <em>Artist Group</em></a><span class="w-right">'+(realOrganizer()&&!preview?'<a class="w-org" href="/">Organizer</a>':'')+(me?'<a class="w-avatar" href="#settings" aria-label="You">'+esc(initials(me))+'</a>':'')+'</span></div>';
}
function backRow(href,label,context=''){
  return '<div class="n-back"><a href="'+href+'">← '+esc(label)+'</a><span>'+esc(context)+'</span></div>';
}
// Title block: big uppercase word(s) over an italic serif accent, with a three-line mono stack on the right.
function titleBlock(top,accent,stack=[]){
  return '<div class="w-hero"><h1>'+esc(top)+'<br><em>'+esc(accent)+'</em></h1><div class="w-date">'+stack.map((l,i)=>i===stack.length-1?'<span class="lime">'+esc(l)+'</span>':esc(l)).join('<br>')+'</div></div>';
}
const sectionHead=(label,count='',extra='')=>'<div class="n-head"><span>'+esc(label)+'</span>'+(extra||'<span class="lime">'+esc(count)+'</span>')+'</div>';
const avatar=(name,i=0,cls='')=>'<span class="n-av '+['lime','purple','paper'][i%3]+' '+cls+'">'+esc(initials({name}))+'</span>';
const toneOf=i=>['lime','paper','purple'][i%3];
function nightPage(html){document.body.classList.add('night');root.innerHTML='<div class="wall night-page">'+html+'</div>';}

/* Meetings tab: the next meeting, its topics, and past meetings. */
function meetingsPage(){
  const next=group.meetings.upcoming.find(m=>m.startsAt)||group.meetings.upcoming[0];
  const others=group.meetings.upcoming.filter(m=>m!==next);
  const pastRows=group.meetings.past.map(m=>{const d=m.startsAt?new Date(m.startsAt):null;return '<a class="n-row" href="#'+m.id+(organizer()?'/view':'')+'"><span class="n-day"><b>'+(d?pad2(d.getDate()):'—')+'</b><span class="lime">'+(d?esc(monShort(d)):'')+'</span></span><span class="n-rowmain">'+esc(m.title)+'<small>'+(m.going?m.going+' came':'Minutes')+'</small></span><span class="lime">→</span></a>';}).join('');
  nightPage(brandRow()+titleBlock('Next','meeting',next?[next.title.split(' ').slice(0,2).join(' ').toUpperCase(),next.location?next.location.toUpperCase():'',next.going+' GOING'].filter(Boolean):['NOTHING','SCHEDULED','YET'])+
    (next?'<div id="n-meeting">Loading…</div>':'<p class="w-none">No meeting is scheduled yet. Organizers will email everyone when one is.</p>')+
    (others.length?sectionHead('Also coming up',others.length+'')+others.map(m=>{const d=m.startsAt?new Date(m.startsAt):null;return '<a class="n-row" href="#'+m.id+(organizer()?'/view':'')+'"><span class="n-day"><b>'+(d?pad2(d.getDate()):'—')+'</b><span class="lime">'+(d?esc(monShort(d)):'TBC')+'</span></span><span class="n-rowmain">'+esc(m.title)+'<small>'+(m.mine?'You: '+rsvpLabels[m.mine]:'RSVP needed')+'</small></span><span class="lime">→</span></a>';}).join(''):'')+
    (group.meetings.past.length?sectionHead('Past meetings','','<a class="lime" href="#decisions">Decisions →</a>')+pastRows:''));
  if(next)api('',undefined,next.id).then(m=>{meeting=asMember(m);const box=document.querySelector('#n-meeting');if(box)box.outerHTML=meetingBody();}).catch(e=>tell(e.message));
}
// The poster, RSVP, phase steps and topics for `meeting` (shared by the Meetings tab and a meeting's own page).
function meetingBody(){
  const m=meeting, d=m.startsAt?new Date(m.startsAt):null, mine=m.rsvp?.status;
  const rsvp=m.me&&!m.past?(m.rsvpReason?'<form class="w-reason n-onpurple" data-form="n-rsvp-no"><label>Why can’t you make it? <small>(only organizers see this)</small><textarea name="reason" required maxlength="500" rows="2">'+esc(m.rsvp?.reason||'')+'</textarea></label><div class="n-rsvp"><button class="on">Send</button><button type="button" data-action="n-rsvp-cancel">Cancel</button></div></form>'
      :'<div class="n-rsvp">'+[['yes','Going'],['maybe','Maybe'],['no','Can’t']].map(([k,l])=>'<button type="button" class="'+(mine===k?'on':'')+'" data-action="n-rsvp" data-value="'+k+'" aria-pressed="'+(mine===k)+'">'+l+'</button>').join('')+'</div>'):'';
  const poster='<div class="n-poster purple"><span class="tape"></span><span class="eyebrow lime">'+esc(d?d.toLocaleDateString('en-GB',{weekday:'long'})+' · '+clock(d)+(m.duration?'–'+clock(new Date(d.getTime()+m.duration*60000)):''):'Date to be set')+'</span>'+
    (d?'<span class="n-num">'+pad2(d.getDate())+'<i>.</i>'+pad2(d.getMonth()+1)+'</span>':'<span class="w-title">'+esc(m.title)+'</span>')+
    '<span class="n-venue"><em>'+esc(m.location||m.title)+'</em><span class="eyebrow">'+m.attendance.going.length+' going</span></span>'+rsvp+
    (m.startsAt?'<a class="n-cal" href="/api/calendar?meeting='+m.id+'">Add to calendar</a>':'')+'</div>';
  const steps=['collect','vote','agenda'], at=steps.indexOf(m.phase);
  const stepper='<div class="n-steps">'+[['01','Suggest'],['02','Vote'],['03','Agenda']].map(([n,l],i)=>'<span class="'+(i===at?'on':i<at?'past':'')+'"><small>'+n+'</small>'+l+'</span>').join('')+'</div><p class="n-hint">'+
    ({collect:'Suggest what we should make time for, and vote on what others suggested.',vote:'Suggestions are closed. Vote on what we make time for. Tap again to undo.',agenda:'The agenda is set.'})[m.phase]+'</p>';
  let topics='';
  if(m.phase==='agenda'){
    const total=m.agenda.reduce((t,a)=>t+a.minutes,0);
    topics=sectionHead('Agenda',total+' minutes')+(m.agenda.length?m.agenda.map((a,i)=>'<div class="n-item"><span class="n-big">'+pad2(i+1)+'</span><span class="n-rowmain">'+esc(a.label)+'<small>'+esc(a.kind)+' · '+a.minutes+' min</small>'+(a.detail?'<span class="n-detail">'+para(a.detail)+'</span>':'')+'</span></div>').join(''):'<p class="w-none">The agenda is empty.</p>');
  }else if(shown('topics')){
    const voted=m.topics.filter(t=>t.mine).length, votable=m.topics.filter(t=>!t.own).length;
    topics=sectionHead('Topics',m.me&&can('topics')?voted+' of '+votable+' voted':m.topics.length+'')+(m.topics.length?m.topics.map((t,i)=>nightTopic(t,i)).join(''):'<p class="w-none">No topics yet.</p>')+
      (m.phase==='collect'&&m.me&&can('topics')?'<form class="n-suggest" data-form="topic"><span class="eyebrow lime">Suggest a topic</span><label><span class="sr">Topic</span><input name="label" maxlength="120" required placeholder="What should we make time for?"></label><label><span class="sr">Details</span><textarea name="detail" maxlength="650" rows="2" placeholder="What would you like to happen? (optional)"></textarea></label><label><span class="sr">Type</span><select name="kind">'+options('Discussion')+'</select></label>'+trap+'<button>Pin it up</button></form>':'');
  }
  const list=m.actions||[];
  return '<div class="n-meet">'+poster+stepper+topics+
    (m.notes?sectionHead('Decided')+'<p class="n-notes">'+para(m.notes)+'</p>':'')+
    (list.length?actionPoster(list):'')+
    (m.me&&shown('comments')?sectionHead('Discussion',(m.discussion||[]).length+'')+'<div class="n-talk">'+comments(m.discussion||[],{kind:'meeting',target:m.id})+'</div>':'')+
    (!m.me?'<div class="n-talk">'+joinPrompt()+'</div>':'')+'</div>';
}
function nightTopic(t,i){
  const canVote=meeting.phase!=='agenda'&&meeting.me&&can('topics')&&!t.own&&!t.hidden;
  const score=t.votes!==null&&t.votes!==undefined?'<b>'+t.votes+'</b>':'';
  const vote=canVote?'<div class="n-vote"><button type="button" data-action="cast" data-topic="'+t.id+'" data-value="1" class="'+(t.mine>0?'on':'')+'" aria-pressed="'+(t.mine>0)+'" aria-label="Vote up: '+esc(t.label)+'">▲</button>'+score+'<button type="button" data-action="cast" data-topic="'+t.id+'" data-value="-1" class="'+(t.mine<0?'on':'')+'" aria-pressed="'+(t.mine<0)+'" aria-label="Vote down: '+esc(t.label)+'">▼</button></div>':(score?'<div class="n-vote">'+score+'</div>':'');
  const talk=t.comments?.length?'<details class="n-tc"><summary>'+t.comments.length+(t.comments.length===1?' comment':' comments')+'</summary>'+comments(t.comments,{form:false,small:true})+'</details>':'<span class="n-tc">No comments yet</span>';
  return '<div class="n-topic"><div><span class="eyebrow lime">'+pad2(i+1)+' — '+esc(t.kind)+(t.own?' · Yours':'')+(t.carried?' · Carried over':'')+'</span><strong>'+esc(t.label)+'</strong>'+(t.detail?'<span class="n-detail">'+esc(t.detail)+'</span>':'')+talk+'</div>'+vote+'</div>';
}
function actionPoster(list){
  return '<div class="n-paper"><span class="tape lime"></span><span class="eyebrow purple">Action items</span>'+list.map(a=>{
    const done=a.status==='done', mine=a.mine;
    return '<div class="n-check'+(done?' done':'')+'">'+(mine?'<button type="button" class="n-box'+(done?' on':'')+'" data-action="action-done" data-item="'+a.id+'" data-meeting="'+a.meeting+'" data-done="'+!done+'" aria-label="'+(done?'Mark not done: ':'Mark done: ')+esc(a.title)+'">'+(done?'✓':'')+'</button>':'<span class="n-box'+(done?' on':'')+'">'+(done?'✓':'')+'</span>')+
      '<span><strong>'+esc(a.title)+'</strong><small>'+esc((a.ownerName||'No owner yet')+(mine?' (you)':''))+' · '+(done?'Done':a.due?'Due '+esc(dueText(a.due)):'No date')+'</small></span></div>';}).join('')+'</div>';
}
/* A meeting's own page: upcoming → the meeting; past → its minutes. */
function meetingView(){
  const m=meeting;
  if(m.past){minutesView();return;}
  const d=m.startsAt?new Date(m.startsAt):null;
  nightPage((group?.me?backRow('#meetings','Meetings',m.title):brandRow())+titleBlock(d?'The':'Next',d?'meeting':'meeting',[m.title.toUpperCase(),d?d.toLocaleDateString('en-GB',{day:'numeric',month:'short'}).toUpperCase():'DATE TBC',m.attendance.going.length+' GOING'])+meetingBody());
}
function minutesView(){
  const m=meeting, d=m.startsAt?new Date(m.startsAt):null, came=m.attendance.going;
  nightPage((group?.me?backRow('#meetings','Meetings','Minutes'):brandRow())+
    '<div class="w-hero"><h1>'+(d?pad2(d.getDate())+'.'+pad2(d.getMonth()+1):esc(m.title))+'<br><em>minutes</em></h1><div class="w-date">'+esc(m.title.toUpperCase())+'<br>'+came.length+' CAME<br><span class="lime">'+(d?d.getFullYear():'')+'</span></div></div>'+
    (came.length?'<div class="n-faces">'+came.map((n,i)=>avatar(n,i)).join('')+'</div>':'')+
    (m.agenda.length?sectionHead('Discussed',m.agenda.length+'')+m.agenda.map((a,i)=>'<div class="n-item"><span class="n-big">'+pad2(i+1)+'</span><span class="n-rowmain">'+esc(a.label)+'<small>'+esc(a.kind)+' · '+a.minutes+' min</small></span></div>').join(''):'')+
    ((m.actions||[]).length?actionPoster(m.actions):'')+
    (m.notes?sectionHead('Notes')+'<p class="n-notes">'+para(m.notes)+'</p>':'')+
    (!m.agenda.length&&!m.notes&&!(m.actions||[]).length?'<p class="w-none">No minutes were recorded for this meeting.</p>':'')+
    (m.me&&shown('comments')?sectionHead('Discussion',(m.discussion||[]).length+'')+'<div class="n-talk">'+comments(m.discussion||[],{kind:'meeting',target:m.id})+'</div>':''));
}

/* Events tab */
const goingBtn=e=>can('events')&&!e.past?'<button type="button" class="n-btn'+(e.going?' on':'')+'" data-action="n-going" data-event="'+e.id+'" data-going="'+!e.going+'" aria-pressed="'+!!e.going+'">'+(e.going?'Going ✓':'I’m going')+'</button>':'';
function eventPoster(e,{big=true}={}){
  const d=new Date(e.startsAt), words=e.title.split(/\s+/), last=words.pop();
  return '<a class="n-poster paper'+(big?' big':'')+'" href="#event/'+e.id+(organizer()?'/view':'')+'"><span class="dot"></span><span class="eyebrow purple">'+esc(dowShort(d)+' '+d.getDate()+' '+monShort(d)+' · '+(e.kind==='Event'?'':e.kind+' ')+clock(d))+'</span><span class="n-show">'+esc(words.join(' '))+(words.length?'<br>':'')+'<em>'+esc(last)+'</em></span><span class="n-foot"><b>'+esc(e.location||'Place to be confirmed')+'</b><b>'+[e.goingCount?e.goingCount+' going':'',e.spots?(e.spots-e.taken)+' spots open':''].filter(Boolean).join(' · ')+'</b></span></a>';
}
function slotLine(s,{event}={}){
  const full=s.people.length>=s.capacity, ppl=s.people;
  const dots=Array.from({length:s.capacity},(_,i)=>'<i class="'+(s.mine&&i===ppl.length-1?'me':i<ppl.length?'on':'')+'"></i>').join('');
  const btn=!can('signups')||event?.past?'':s.mine?'<button type="button" class="n-btn on" data-action="w-unclaim" data-slot="'+s.id+'">Signed up ✓</button>':full?'<span class="n-btn off">Full</span>':'<button type="button" class="n-btn" data-action="w-claim" data-slot="'+s.id+'">Sign me up</button>';
  const at=s.startsAt?new Date(s.startsAt):s.local?new Date(s.local):event?new Date(event.startsAt):null, timed=s.startsAt?s.timed:!!s.local;
  const when=at?dowShort(at)+' '+at.getDate()+' '+monShort(at)+(timed?' · '+clock(at):''):'';
  return '<div class="n-slot'+(full&&!s.mine?' full':'')+'"><span><span class="eyebrow lime">'+esc(when)+'</span><strong>'+esc(s.label)+'</strong><small><span class="n-dots">'+dots+'</span>'+(ppl.length?esc(ppl.join(', '))+' · '+ppl.length+' of '+s.capacity:'Nobody yet · 0 of '+s.capacity)+'</small></span>'+btn+'</div>';
}
function eventsPage(){
  const list=eventList.upcoming, first=list[0], rest=list.slice(1);
  const slots=first&&shown('signups')?(group.slots||[]).filter(s=>s.event===first.id):[];
  const open=slots.reduce((n,s)=>n+Math.max(0,s.capacity-s.people.length),0);
  nightPage(brandRow()+titleBlock('Coming','up',['SHOWS','WORKSHOPS','OPEN DAYS'])+
    (first?eventPoster(first)+(goingBtn(first)?'<div class="n-pad">'+goingBtn(first)+'</div>':''):'<p class="w-none">Nothing coming up yet.</p>')+
    (slots.length?sectionHead('Help wanted',open+(open===1?' spot open':' spots open'))+slots.map(s=>slotLine(s,{event:first})).join(''):'')+
    (rest.length?sectionHead('Also on',rest.length+'')+rest.map(e=>{const d=new Date(e.startsAt);return '<div class="w-row"><div class="w-day"><span>'+pad2(d.getDate())+'</span><span class="lime">'+esc(dowShort(d)+' '+monShort(d))+'</span></div><div class="w-items"><div class="w-item"><span class="eyebrow lime">'+esc(e.kind)+'</span><a class="w-ititle" href="#event/'+e.id+(organizer()?'/view':'')+'">'+esc(e.title)+'</a><span class="w-meta">'+esc([clock(d),e.location,e.goingCount?e.goingCount+' going':''].filter(Boolean).join(' · '))+(e.signedUp?' · You’re helping':'')+'</span>'+goingBtn(e).replace('class="n-btn','class="w-act n-btn')+'</div></div></div>';}).join(''):'')+
    (can('events')?'<details class="n-add"><summary>Add an event</summary><form data-form="event-create">'+eventFields()+'<button>Add event</button><p class="n-hint">You can add sign-up slots, like gallery sitting or install crew, on the next page.</p></form></details>':'')+
    (eventList.past.length?sectionHead('Past',eventList.past.length+'')+eventList.past.slice(0,10).map(e=>'<a class="n-row" href="#event/'+e.id+'"><span class="n-rowmain">'+esc(e.title)+'<small>'+esc(e.when)+'</small></span><span class="lime">→</span></a>').join(''):''));
}
function eventView(){
  const e=event;
  const slots=e.slots.map(s=>({...s,people:s.people.map(p=>p.name),mine:s.mine}));
  const open=slots.reduce((n,s)=>n+Math.max(0,s.capacity-s.people.length),0);
  nightPage(backRow('#events','Events',e.kind)+eventPoster({...e,spots:0,taken:0})+
    (e.link?'<p class="n-link"><a href="'+esc(e.link)+'" target="_blank" rel="noopener">'+esc(e.link)+'</a></p>':'')+
    '<p class="n-link">'+esc(e.when)+(e.location?' · '+esc(e.location):'')+'</p>'+
    sectionHead('Who’s going',e.goingPeople.length+'')+(goingBtn(e)?'<div class="n-pad">'+goingBtn(e)+'</div>':'')+
      (e.goingPeople.length?'<div class="n-faces">'+e.goingPeople.map((n,i)=>avatar(n,i)).join('')+'</div><p class="n-hint">'+esc(e.goingPeople.join(', '))+'</p>':'<p class="w-none">Nobody yet.'+(goingBtn(e)?' Be the first.':'')+'</p>')+
    (e.description?sectionHead('About')+'<p class="n-body">'+para(e.description)+'</p><p class="n-hint">Added by '+esc(e.author||'a member')+'</p>':'')+
    (slots.length&&shown('signups')?sectionHead('Help wanted',open+(open===1?' spot open':' spots open'))+slots.map(s=>slotLine(s,{event:e})).join(''):'')+
    (e.canEdit&&!preview?'<p class="n-link"><a class="lime" href="#event/'+e.id+'/manage">Manage this event →</a></p>':'')+
    (shown('comments')?sectionHead('Discussion',e.comments.length+'')+'<div class="n-talk">'+comments(e.comments,{kind:'event',target:e.id})+'</div>':''));
}

/* Calls tab */
function statusButtons(c,tone){
  if(!can('calls')||c.closed)return '';
  return '<div class="n-status t-'+tone+'">'+Object.entries(interestLabels).map(([k,l])=>'<button type="button" class="'+(c.myStatus===k?'on':'')+'" data-action="interest" data-call="'+c.id+'" data-status="'+(c.myStatus===k?'none':k)+'" aria-pressed="'+(c.myStatus===k)+'">'+l+'</button>').join('')+'</div>';
}
function callPoster(c,i){
  const left=daysUntil(c.deadline), tone=toneOf(i);
  return '<div class="n-call '+tone+'"><span class="tape"></span><a class="n-callhead" href="#call/'+c.id+'"><span class="n-days">'+Math.max(0,left)+'</span><span><span class="eyebrow">'+esc(c.kind)+' · '+(left===0?'due today':left===1?'day left':'days left')+'</span><span class="n-ctitle">'+esc(c.title)+'</span></span></a>'+
    '<span class="n-cmeta">'+esc([c.organization,c.award].filter(Boolean).join(' · ')||'Open call')+'</span><span class="eyebrow">'+(c.applying?c.applying+' from the group applying':'Nobody from the group yet')+'</span>'+statusButtons(c,tone)+'</div>';
}
function callsPage(){
  const kinds=[...new Set(callList.open.map(c=>c.kind))];
  const shownCalls=callList.open.filter(c=>!callFilter||c.kind===callFilter);
  nightPage(brandRow()+titleBlock('Open','calls',['RESIDENCIES','GRANTS','EXHIBITIONS'])+
    (kinds.length>1?'<div class="n-chips">'+['',...kinds].map(k=>'<button type="button" class="'+(callFilter===k?'on':'')+'" data-action="call-filter" data-kind="'+esc(k)+'">'+esc(k||'All')+'</button>').join('')+'</div>':'')+
    '<div class="n-calls">'+(shownCalls.length?shownCalls.map(callPoster).join(''):'<p class="w-none">No open calls yet.'+(can('calls')?' Share one below.':'')+'</p>')+'</div>'+
    (can('calls')?'<details class="n-add"><summary>Share an open call</summary><form data-form="call-create">'+callFields()+'<button>Share with the group</button></form></details>':'')+
    (callList.closed.length?sectionHead('Closed',callList.closed.length+'')+callList.closed.map(c=>'<a class="n-row" href="#call/'+c.id+'"><span class="n-rowmain">'+esc(c.title)+'<small>'+esc(c.kind)+' · closed '+esc(dueText(c.deadline))+'</small></span><span class="lime">→</span></a>').join(''):''));
}
function callPage(){
  const c=call, left=daysUntil(c.deadline);
  const facts=[['Award',c.award],['Deadline',dueText(c.deadline)+(c.closed?' (closed)':'')],['Offered by',c.organization],['Link',c.link?'<a href="'+esc(c.link)+'" target="_blank" rel="noopener">'+esc(c.link.replace(/^https?:\/\//,''))+'</a>':'']].filter(([,v])=>v);
  const people=Object.entries(c.people).flatMap(([s,list])=>list.map(n=>({n,s})));
  nightPage(backRow('#calls','Calls',c.kind)+
    '<div class="n-poster lime"><span class="tape"></span>'+(c.closed?'<span class="eyebrow">Closed</span>':'<span class="n-left"><b>'+Math.max(0,left)+'</b><span>'+(left===1?'day':'days')+'<br>to apply</span></span>')+'<span class="w-title">'+esc(c.title)+'</span>'+(c.organization?'<em class="n-org">'+esc(c.organization)+'</em>':'')+'</div>'+
    '<div class="n-facts">'+facts.map(([k,v])=>'<div><span class="eyebrow lime">'+k+'</span><span>'+(k==='Link'?v:esc(v))+'</span></div>').join('')+'</div>'+
    (c.details?sectionHead('Details')+'<p class="n-body">'+para(c.details)+'</p><p class="n-hint">Shared by '+esc(c.author||'a member')+'</p>':'')+
    (can('calls')&&!c.closed?sectionHead('Your status')+statusButtons(c,'ink')+'<p class="n-hint">Interested or applying gets you reminders a week and a day before the deadline.</p>':'')+
    sectionHead('From the group',people.length+'')+(people.length?people.map((p,i)=>'<div class="n-person">'+avatar(p.n,i)+'<span>'+esc(p.n)+'</span><span class="eyebrow lime">'+interestLabels[p.s]+'</span></div>').join(''):'<p class="w-none">Nobody yet.</p>')+
    (shown('comments')?sectionHead('Discussion',c.comments.length+'')+'<div class="n-talk">'+comments(c.comments,{kind:'call',target:c.id})+'</div>':'')+
    (c.canEdit&&!preview?'<details class="n-add"><summary>Edit this call</summary><form data-form="call-update">'+callFields(c)+'<button>Save</button></form></details><div class="n-danger">'+(organizer()?'<button type="button" data-action="call-hide" data-hidden="'+!c.hidden+'">'+(c.hidden?'Show call':'Hide call')+'</button>':'')+'<button type="button" data-action="call-delete">Delete this call</button></div>':''));
}

/* Members directory and You */
let directory=[], memberFilter='', memberQuery='';
function directoryPage(){
  const q=memberQuery.trim().toLowerCase();
  const list=directory.filter(m=>(!memberFilter||(memberFilter==='organizer'?m.role==='organizer':memberFilter==='in'?m.inToday:m.title===memberFilter))&&(!q||(m.name+' '+m.medium+' '+m.title).toLowerCase().includes(q)));
  const since=directory.reduce((y,m)=>Math.min(y,new Date(m.since).getFullYear()),new Date().getFullYear());
  const rows=list.map((m,i)=>'<div class="n-person big">'+avatar(m.name,i)+'<span><strong>'+esc(m.name)+(m.me?' (you)':'')+'</strong><small>'+esc(m.medium||'Member since '+new Date(m.since).getFullYear())+'</small></span><span class="n-tags">'+(m.title?'<span class="eyebrow lime">'+esc(m.title)+'</span>':'')+(m.role==='organizer'?'<span class="eyebrow">Organizer</span>':'')+(m.inToday?'<span class="eyebrow">In today</span>':'')+'</span></div>').join('');
  const box=document.querySelector('#n-dir');
  if(box){box.innerHTML=rows||'<p class="w-none">Nobody matches.</p>';return;}
  nightPage(backRow('#settings','You',directory.length+' members')+titleBlock('The','group',['SINCE',String(since),'EST.'])+
    '<div class="n-search"><label><span class="sr">Find someone</span><input id="n-q" type="search" placeholder="Find someone or a technique" value="'+esc(memberQuery)+'"></label></div>'+
    '<div class="n-chips">'+[['','All'],...[...new Set(directory.map(m=>m.title).filter(Boolean))].map(t=>[t,t]),['organizer','Organizers'],['in','In today']].map(([k,l])=>'<button type="button" class="'+(memberFilter===k?'on':'')+'" data-action="n-mfilter" data-role="'+k+'">'+l+'</button>').join('')+'</div>'+
    '<div id="n-dir" class="n-rule">'+(rows||'<p class="w-none">Nobody matches.</p>')+'</div>');
}
function settingsPage(){
  const me=group.me, mineMeet=group.meetings.upcoming.filter(m=>m.mine==='yes'||m.mine==='maybe');
  const down=[
    ...mineMeet.filter(m=>m.startsAt).map(m=>({d:new Date(m.startsAt),k:'Meeting · '+rsvpLabels[m.mine],t:m.title,h:'#'+m.id+(organizer()?'/view':'')})),
    ...(group.upcomingEvents||[]).filter(e=>e.going).map(e=>({d:new Date(e.startsAt),k:e.kind+' · Going',t:e.title,h:'#event/'+e.id+(organizer()?'/view':'')})),
    ...(group.slots||[]).filter(s=>s.mine).map(s=>({d:new Date(s.startsAt),k:'Sign-up · '+s.eventTitle,t:s.label,h:'#event/'+s.event})),
    ...(group.openCalls||[]).filter(c=>c.myStatus).map(c=>({d:deadlineDate(c.deadline),k:c.kind+' · '+interestLabels[c.myStatus],t:c.title,h:'#call/'+c.id})),
    ...(group.myActions||[]).map(a=>({d:a.due?deadlineDate(a.due):null,k:'Action item'+(a.due?' · due':''),t:a.title,h:'#'+a.meeting+(organizer()?'/view':'')}))
  ].sort((a,b)=>(a.d??Infinity)-(b.d??Infinity));
  const value=me.emails==='none'?'none':me.digest;
  const opt=(v,l,dsc)=>'<label class="n-switch"><span><strong>'+l+'</strong><small>'+dsc+'</small></span><input type="radio" name="email" value="'+v+'"'+(value===v?' checked':'')+'><i></i></label>';
  nightPage(backRow(organizer()?'#me':'/','Wall','')+
    '<div class="n-poster lime n-profile"><span class="tape"></span><span class="n-av purple huge">'+esc(initials(me))+'</span><span><span class="w-title">'+esc(me.name||me.email.split('@')[0])+'</span><em class="n-org">'+esc(me.medium||(me.role==='organizer'?'Organizer':'Member'))+'</em><span class="eyebrow">'+esc([me.title,me.role==='organizer'&&me.medium?'Organizer':'','Member since '+new Date(me.since||Date.now()).getFullYear()].filter(Boolean).join(' · '))+'</span><span class="eyebrow">'+esc(me.email)+'</span></span></div>'+
    sectionHead('You’re down for',down.length+(down.length===1?' thing':' things'))+
    (down.length?down.map(x=>'<a class="n-row" href="'+x.h+'"><span class="n-day"><b>'+(x.d?pad2(x.d.getDate()):'—')+'</b><span class="lime">'+(x.d?esc(monShort(x.d)):'Any')+'</span></span><span class="n-rowmain"><span class="eyebrow lime">'+esc(x.k)+'</span>'+esc(x.t)+'</span></a>').join(''):'<p class="w-none">Nothing yet. Answer a few things on the wall.</p>')+
    '<div class="n-row"><span class="n-rowmain">In the studio today?<small>Shows you as “In today” for 12 hours</small></span>'+(()=>{const mine=(group.inToday||[]).some(p=>p.me);return '<button type="button" class="n-btn'+(mine?' on':'')+'" data-action="n-checkin" data-in="'+!mine+'" aria-pressed="'+mine+'">'+(mine?'In today ✓':'I’m in today')+'</button>';})()+'</div>'+
    '<a class="n-row" href="#group"><span class="n-rowmain">Members directory<small>Who’s in the group'+((group.inToday||[]).length?' · '+group.inToday.length+' in today':'')+'</small></span><span class="lime">→</span></a>'+
    '<form data-form="profile">'+sectionHead('Email me')+'<fieldset class="n-fs"><legend class="sr">Email</legend>'+
      opt('instant','Everything right away','Each post and reply as it happens')+opt('daily','Daily summary','One email a day with what’s new')+opt('weekly','Weekly summary','One email on Mondays')+opt('none','Off','No emails at all, not even invitations')+
    '</fieldset><p class="n-hint">Meeting invitations, agendas and reminders always come right away unless email is off.</p>'+
    sectionHead('Your name')+'<div class="n-search"><label><span class="sr">Name</span><input name="name" maxlength="80" value="'+esc(me.name)+'"></label></div>'+
    sectionHead('Your medium')+'<div class="n-search"><label><span class="sr">Medium</span><input name="medium" maxlength="80" value="'+esc(me.medium||'')+'" placeholder="Relief, woodcut"></label></div><div class="n-pad"><button class="n-btn on">Save</button></div></form>'+
    '<div class="n-panels">'+installPanel()+calendarPanel()+'</div>'+
    '<div class="n-pad"><button type="button" class="n-signout" data-action="signout">Sign out</button></div>');
}

/* Pages the design didn't cover, in the same language */
/* Sign in (screen 09): email, then a 6-digit code with a keypad. */
let signStep='email', signAddr='', signCode='', signName='';
function welcome(){
  const poster='<div class="n-poster lime n-brandposter"><span class="tape"></span><span class="sq"></span><span class="eyebrow">Members only</span><span class="n-tp">Tower<br>Press</span><em class="n-org purple">Artist Group</em></div>';
  const setup='<form data-form="setup"><label>Organizer key<input type="password" name="organizerKey" required autocomplete="off"></label><label>Your name<input name="name" maxlength="80" required></label><label>Your email<input type="email" name="email" required maxlength="254"></label><button>Set up and sign in</button></form>';
  let body;
  if(signStep==='in'){
    body='<div class="n-signin"><span class="n-welcome">Welcome back,<br><em>'+esc(signName)+'</em></span><a class="n-wide" href="/">Go to the wall</a></div>';
  }else if(signStep==='code'){
    const boxes=Array.from({length:6},(_,i)=>'<span class="'+(i===signCode.length?'now':'')+'">'+esc(signCode[i]||'')+'</span>').join('');
    const keys=['1','2','3','4','5','6','7','8','9','','0','del'].map(k=>k===''?'<span></span>':'<button type="button" data-action="'+(k==='del'?'n-del':'n-key')+'" data-key="'+k+'" aria-label="'+(k==='del'?'Delete':k)+'">'+(k==='del'?'⌫':k)+'</button>').join('');
    body='<div class="n-signin"><span class="eyebrow">Enter the code we sent to</span><span class="n-addr">'+esc(signAddr)+'</span>'+
      '<label class="n-codefield"><span class="sr">6-digit code</span><input id="n-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value="'+esc(signCode)+'"><span class="n-boxes" aria-hidden="true">'+boxes+'</span></label>'+
      '<div class="n-keys">'+keys+'</div><button type="button" class="n-textbtn" data-action="n-change">← Change email</button></div>';
  }else{
    body='<form class="n-signin" data-form="n-signin"><label><span class="eyebrow">Sign in with your studio email</span><input class="n-serif" type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.org" value="'+esc(signAddr)+'"></label><p class="n-hint flush">We’ll email you a 6-digit code. You won’t need a password.</p><button class="n-wide">Send me a code</button></form>'+
      '<details class="n-add"><summary>Not a member yet? Ask to join</summary><form data-form="join"><p class="n-hint flush">An organizer will approve you, and you’ll get an email.</p><label>Name<input name="name" required maxlength="80" autocomplete="name"></label><label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label>'+trap+'<button>Ask to join</button></form></details>';
  }
  nightPage(poster+body+
    (group.needsSetup?'<div class="n-add open"><span class="eyebrow lime">Set up the group</span><p class="n-hint flush">No organizers yet. Enter the organizer key from Vercel to become the first organizer.</p>'+setup+'</div>'
      :signStep==='email'?'<details class="n-add"><summary>Organizer key</summary><p class="n-hint flush">Lost access? The organizer key from Vercel signs you in as an organizer.</p>'+setup+'</details>':''));
  if(signStep==='code')document.querySelector('#n-code')?.focus();
}
async function signDigits(value){
  signCode=value.replace(/\D/g,'').slice(0,6);
  welcome();
  if(signCode.length<6)return;
  await new Promise(r=>setTimeout(r,450));
  try{
    await groupApi('code',{email:signAddr,code:signCode});
    const g=await groupApi();signName=g.me?.name||g.me?.email.split('@')[0]||'';signStep='in';welcome();
  }catch(error){signCode='';welcome();tell(error.message);}
}

/* Posts (screen 10) and a post (screen 11) */
let composer=false;
let postFilter='', postTags=['General','Studio','Kit','Shows','Swap'];
const plusBtn=p=>can('posts')?'<button type="button" class="n-plus'+(p.myPlus?' on':'')+'" data-action="n-plus" data-post="'+p.id+'" data-plus="'+!p.myPlus+'" aria-pressed="'+!!p.myPlus+'" aria-label="+1 this post">+1 · '+(p.plus||0)+'</button>':'<span class="n-plus off">+1 · '+(p.plus||0)+'</span>';
function postCard(p,i){
  const tone=p.pinned?'lime':'paper';
  const tag=[p.pinned?'Pinned':'',p.tag&&p.tag!=='General'?p.tag:'',p.hidden?'Hidden':''].filter(Boolean).join(' · ');
  return '<div class="n-postcard '+tone+(i%2?' tilt':'')+'"><span class="tape"></span><a class="n-pcard" href="#post/'+p.id+'"><span class="n-by">'+avatar(p.author,p.pinned?1:i,'small')+'<span><b>'+esc(p.author)+'</b><small>'+esc(ago(p.created))+'</small></span>'+(tag?'<span class="n-tag">'+esc(tag)+'</span>':'')+'</span>'+
    '<span class="n-ptitle">'+esc(p.title)+'</span>'+(p.excerpt?'<span class="n-pbody">'+esc(p.excerpt.slice(0,160))+(p.excerpt.length>160?'…':'')+'</span>':'')+'</a>'+
    '<span class="n-pfoot">'+plusBtn(p)+'<a href="#post/'+p.id+'">'+(p.replies?p.replies+(p.replies===1?' reply':' replies'):'No replies yet')+' →</a></span></div>';
}
function boardPage(){
  nightPage(backRow(organizer()?'#me':'/','Wall',postList.length+' on the board')+
    '<div class="w-hero"><h1>Posts<br><em>&amp; notes</em></h1>'+(can('posts')?'<button type="button" class="n-pin" data-action="n-compose">+ Pin a post</button>':'')+'</div>'+
    (()=>{const used=[...new Set(postList.map(p=>p.tag).filter(t=>t&&t!=='General'))];return used.length?'<div class="n-chips">'+['',...used].map(t=>'<button type="button" class="'+(postFilter===t?'on':'')+'" data-action="n-pfilter" data-tag="'+esc(t)+'">'+esc(t||'All')+'</button>').join('')+'</div>':'';})()+
    '<div class="n-posts">'+(postList.filter(p=>!postFilter||p.tag===postFilter).length?postList.filter(p=>!postFilter||p.tag===postFilter).map(postCard).join(''):'<p class="w-none">Nothing on the board yet.'+(can('posts')?' Pin the first post.':'')+'</p>')+'</div>'+
    (composer?'<button type="button" class="w-scrim" data-action="n-compose-close" aria-label="Close"></button><form class="w-sheet n-composer" data-form="post" role="dialog" aria-modal="true" aria-label="Pin a post"><span class="tape"></span><span class="eyebrow">New post · everyone gets it by email</span><label><span class="sr">Headline</span><input name="title" required maxlength="140" placeholder="Headline" autocomplete="off"></label><label><span class="sr">Details</span><textarea name="body" maxlength="6000" rows="5" placeholder="Details (optional)"></textarea></label><fieldset class="n-tagpick"><legend class="sr">Tag</legend>'+postTags.map((t,i)=>'<label><input type="radio" name="tag" value="'+t+'"'+(i===0?' checked':'')+'><span>'+t+'</span></label>').join('')+'</fieldset><div class="w-sfoot"><button type="button" data-action="n-compose-close">Close ✕</button><button class="w-opt on n-pinit" disabled>Pin it up</button></div></form>':''));
  if(composer)document.querySelector('.n-composer input')?.focus();
}
function replyList(list){
  return list.map((c,i)=>'<div class="n-reply'+(c.hidden?' hidden-topic':'')+'">'+avatar(c.author,i)+'<span><span class="n-rhead"><b>'+esc(c.author)+'</b><span class="eyebrow lime">'+esc(ago(c.created))+(c.via==='email'?' · email':'')+'</span></span><span class="n-rbody">'+para(c.body)+'</span>'+((c.mine||organizer())?'<button type="button" class="link" data-action="delete-comment" data-comment="'+c.id+'">Delete</button>':'')+'</span></div>').join('');
}
function replyBox(kind,target){
  if(!can('comments'))return '';
  return '<form class="n-replybox" data-form="comment" data-kind="'+kind+'" data-target="'+target+'"><label><span class="sr">Your reply</span><textarea name="body" maxlength="3000" required rows="2" placeholder="Write a reply"></textarea></label><button disabled>Reply</button></form>';
}
function postPage(){
  const p=post;
  nightPage(backRow('#board','Posts',[p.pinned?'Pinned':'',p.tag&&p.tag!=='General'?p.tag:''].filter(Boolean).join(' · '))+
    '<div class="n-poster paper n-post"><span class="tape lime"></span><span class="n-by">'+avatar(p.author,1)+'<span><b>'+esc(p.author)+'</b><small>'+esc(ago(p.created))+(p.hidden?' · hidden':'')+'</small></span></span><span class="n-ptitle big">'+esc(p.title)+'</span>'+(p.body?'<span class="n-pbody">'+para(p.body)+'</span>':'')+
    '<span class="n-pfoot">'+plusBtn(p)+'<span>'+p.comments.length+(p.comments.length===1?' reply':' replies')+'</span></span></div>'+
    (shown('comments')?sectionHead('Replies')+'<div class="n-replies">'+(p.comments.length?replyList(p.comments):'<p class="w-none">No replies yet.</p>')+'</div>'+replyBox('post',p.id):'')+
    ((organizer()||p.mine)?'<div class="n-danger">'+(organizer()?'<button type="button" data-action="pin-post" data-pinned="'+!p.pinned+'">'+(p.pinned?'Unpin':'Pin to top')+'</button><button type="button" data-action="hide-post" data-hidden="'+!p.hidden+'">'+(p.hidden?'Show':'Hide')+'</button>':'')+'<button type="button" data-action="delete-post">Delete post</button></div>':''));
}

/* Decisions (screen 12): the log of what past meetings decided. */
let decFilter='';
function decisionsPage(){
  const q=(document.querySelector('#search')?.value||'').trim().toLowerCase();
  const kinds=[...new Set(decisionsData.flatMap(m=>m.agenda.map(a=>a.kind)))];
  let n=decisionsData.reduce((t,m)=>t+m.agenda.length,0);
  const closedP=(shown('proposals')?proposalData.closed:[]).filter(p=>(!decFilter||decFilter==='proposals')&&(!q||(p.title+' '+p.summary).toLowerCase().includes(q)));
  const pRow=p=>{const d=new Date(p.closedAt);return {d,html:'<div class="w-row"><div class="w-day"><span>'+pad2(d.getDate())+'</span><span class="lime">'+esc(monShort(d)+' '+String(d.getFullYear()).slice(2))+'</span></div><div class="w-items"><div class="w-item'+(p.status==='carried'?'':' n-lost')+'"><span class="eyebrow lime">P-'+p.number+' — '+esc(p.kind)+'</span><a class="w-ititle" href="#proposal/'+p.id+'">'+esc(p.title)+'</a><span class="w-meta">'+esc(resultText(p))+' · '+p.counts.for+'–'+p.counts.against+(p.counts.abstain?' · '+p.counts.abstain+' abstain':'')+'</span></div></div></div>'};};
  const rows0=decisionsData.map(m=>{
    const d=m.startsAt?new Date(m.startsAt):null;
    const items=m.agenda.map(a=>({...a,num:n--})).filter(a=>(!decFilter||a.kind===decFilter)&&decFilter!=='proposals'&&(!q||(a.label+' '+a.detail+' '+m.title).toLowerCase().includes(q)));
    const notes=(!decFilter||decFilter==='notes')&&decFilter!=='proposals'&&m.notes&&(!q||m.notes.toLowerCase().includes(q)||m.title.toLowerCase().includes(q));
    if(!items.length&&!notes)return '';
    return '<div class="w-row"><div class="w-day"><span>'+(d?pad2(d.getDate()):'—')+'</span><span class="lime">'+(d?esc(monShort(d)+' '+String(d.getFullYear()).slice(2)):'')+'</span></div><div class="w-items">'+
      items.map(a=>'<div class="w-item"><span class="eyebrow lime">D-'+a.num+' — '+esc(a.kind)+'</span><a class="w-ititle" href="#'+m.id+(organizer()?'/view':'')+'">'+esc(a.label)+'</a><span class="w-meta">'+esc(m.title)+' · '+a.minutes+' min</span></div>').join('')+
      (notes?'<div class="w-item"><span class="eyebrow lime">Notes</span><span class="n-notes small flush">'+para(m.notes)+'</span></div>':'')+'</div></div>';
  });
  const merged=[...decisionsData.map((m,i)=>({d:m.startsAt?new Date(m.startsAt):new Date(0),html:rows0[i]})),...closedP.map(pRow)].sort((a,b)=>b.d-a.d);
  const rows=merged.map(r=>r.html).join('');
  const results=document.querySelector('#results');
  if(results){results.innerHTML=rows||'<p class="w-none">Nothing matches.</p>';return;}
  const total=decisionsData.reduce((t,m)=>t+m.agenda.length,0)+(proposalData.closed||[]).length;
  nightPage(backRow('#meetings','Meetings',decisionsData.length+(decisionsData.length===1?' meeting':' meetings'))+titleBlock('What we','decided',[total+' ON','RECORD',decisionsData.length+(decisionsData.length===1?' MEETING':' MEETINGS')])+
    proposalSection()+
    '<div class="n-search"><label><span class="sr">Search</span><input id="search" type="search" placeholder="Search decisions, topics, people"></label></div>'+
    '<div class="n-head"><span>The log</span>'+(kinds.length>1||proposalData.closed.length?'<div class="w-seg">'+[['','All'],...(shown('proposals')&&proposalData.closed.length?[['proposals','Proposals']]:[]),...kinds.map(k=>[k,k]),['notes','Notes']].map(([k,l])=>'<button type="button" data-action="n-dfilter" data-kind="'+esc(k)+'" aria-pressed="'+(decFilter===k)+'">'+esc(l)+'</button>').join('')+'</div>':'')+'</div>'+
    '<div id="results">'+(rows||'<p class="w-none">No past meetings yet.</p>')+'</div>');
}

/* Proposals (screens 12 and 13) */
let proposalData={open:[],drafts:[],closed:[]}, proposal=null, proposalKinds=[], proposing=false;
const resultText=p=>({carried:'Carried',not_carried:'Not carried',no_quorum:'No quorum'})[p.status]||'';
const closesLabel=ms=>{const d=new Date(ms);return dowShort(d)+' '+d.getDate()+' '+monShort(d)+', '+clock(d);};
function tallyBar(p,tone){
  const N=Math.max(1,p.eligible), f=p.counts.for/N*100, a=p.counts.against/N*100;
  return '<div class="n-tally '+tone+'"><i style="width:'+f+'%"></i><i class="ag" style="width:'+a+'%"></i></div>'+
    '<div class="n-tline"><span>'+p.counts.for+' for · '+p.counts.against+' against · '+p.counts.abstain+' abstain</span><span>'+(p.quorumMet?'Quorum met':p.voted+' of '+p.quorum+' to count')+'</span></div>';
}
function voteButtons(p,tone){
  if(!can('proposals')||p.status!=='open')return '';
  return '<div class="n-status t-'+tone+'">'+Object.entries({for:'For',against:'Against',abstain:'Abstain'}).map(([k,l])=>'<button type="button" class="'+(p.myVote===k?'on':'')+'" data-action="n-pvote" data-proposal="'+p.id+'" data-vote="'+(p.myVote===k?'none':k)+'" aria-pressed="'+(p.myVote===k)+'">'+l+'</button>').join('')+'</div>';
}
function proposalPoster(p,i){
  const tone=i%2?'purple':'lime';
  return '<div class="n-call '+tone+'"><span class="tape"></span><a class="n-plink" href="#proposal/'+p.id+'"><span class="n-prow"><span class="eyebrow">P-'+p.number+' · '+esc(p.kind)+'</span><span class="eyebrow">'+esc(closesLabel(p.closesAt))+'</span></span><span class="n-ctitle">'+esc(p.title)+'</span>'+(p.figure||p.summary?'<span class="n-cmeta">'+esc([p.figure,p.summary].filter(Boolean).join(' — ').slice(0,180))+'</span>':'')+'</a>'+tallyBar(p,tone)+voteButtons(p,tone)+'</div>';
}
function proposalForm(p={}){
  return '<label>Title<input name="title" required maxlength="140" value="'+esc(p.title||'')+'" placeholder="Shared press maintenance fund"></label>'+
    '<div class="row"><label>Kind<select name="kind">'+proposalKinds.map(k=>'<option'+((p.kind||'Other')===k?' selected':'')+'>'+k+'</option>').join('')+'</select></label><label>Voting open for<select name="days">'+[3,5,7,10,14,21,30].map(d=>'<option value="'+d+'"'+((p.days||7)===d?' selected':'')+'>'+d+' days</option>').join('')+'</select></label></div>'+
    '<label>In a few words <small>(optional, shown big)</small><input name="figure" maxlength="40" value="'+esc(p.figure||'')+'" placeholder="£5 a month each"></label>'+
    '<label>What you propose<textarea name="summary" maxlength="2000" rows="3">'+esc(p.summary||'')+'</textarea></label>'+
    '<label>Why <small>(optional)</small><textarea name="reason" maxlength="1000" rows="2">'+esc(p.reason||'')+'</textarea></label>'+
    '<label>If carried <small>(what happens, optional)</small><input name="effect" maxlength="500" value="'+esc(p.effect||'')+'" placeholder="Starts January. Collected with studio rent."></label>';
}
function proposalSection(){
  if(!shown('proposals'))return '';
  const open=proposalData.open, drafts=proposalData.drafts;
  const need=open.filter(p=>!p.myVote).length;
  return sectionHead('Open · vote now',open.length?(can('proposals')&&need?need+' need your vote':open.length+' open'):'')+
    (open.length?open.map(proposalPoster).join(''):'<p class="w-none">Nothing up for a vote right now.</p>')+
    (drafts.length?sectionHead('Waiting for a seconder',drafts.length+'')+drafts.map(p=>'<a class="n-row" href="#proposal/'+p.id+'"><span class="n-rowmain"><span class="eyebrow lime">P-'+p.number+' · '+esc(p.kind)+'</span>'+esc(p.title)+'<small>Proposed by '+esc(p.author||'a member')+(p.mine?' (you)':'')+'</small></span><span class="lime">→</span></a>').join(''):'')+
    (can('proposals')?'<div class="n-pad"><button type="button" class="n-btn" data-action="n-propose">+ Make a proposal</button></div>':'')+
    (proposing?'<button type="button" class="w-scrim" data-action="n-propose-close" aria-label="Close"></button><form class="w-sheet n-composer n-pform" data-form="n-propose" role="dialog" aria-modal="true" aria-label="Make a proposal"><span class="tape"></span><span class="eyebrow">New proposal · opens for voting once someone seconds it</span>'+proposalForm()+'<div class="w-sfoot"><button type="button" data-action="n-propose-close">Close ✕</button><button class="w-opt on">Put it up</button></div></form>':'');
}
// "£5 a month each": the first word big, the rest small beside it (the whole thing smaller if the first word is long).
function figureHtml(text){
  const [head,...rest]=text.trim().split(/\s+/);
  if(head.length>6)return '<span class="n-figure long">'+esc(text)+'</span>';
  return '<span class="n-figure"><b>'+esc(head)+'</b>'+(rest.length?'<span>'+esc(rest.join(' '))+'</span>':'')+'</span>';
}
function proposalPage(){
  const p=proposal, open=p.status==='open', draft=p.status==='draft';
  const facts=[['Proposed by',p.author],['Seconded',p.seconder||(draft?'Waiting for a seconder':'')],['If carried',p.effect],['To pass','More For than Against, and '+p.quorum+' of '+p.eligible+' must vote']].filter(([,v])=>v);
  const counts='<div class="n-counts"><span><b class="lime">'+p.counts.for+'</b>For</span><span><b>'+p.counts.against+'</b>Against</span><span><b class="lav">'+p.counts.abstain+'</b>Abstain</span></div>';
  const voters=p.voters.map((v,i)=>'<span class="n-av '+(v.vote==='for'?'lime':v.vote==='against'?'paper':'purple')+'" title="'+esc(v.name+': '+({for:'For',against:'Against',abstain:'Abstain'})[v.vote])+'">'+esc(initials({name:v.name}))+'</span>').join('')+p.notVoted.map(n=>'<span class="n-av hollow" title="'+esc(n)+': not voted">'+esc(initials({name:n}))+'</span>').join('');
  nightPage(backRow('#decisions','Decisions','P-'+p.number+' · '+p.kind)+
    '<div class="n-poster lime"><span class="tape"></span><span class="eyebrow">'+(open?'Proposal · closes '+esc(closesLabel(p.closesAt)):draft?'Proposal · waiting for a seconder':esc(resultText(p))+' · '+p.counts.for+'–'+p.counts.against)+'</span>'+
      (p.figure?figureHtml(p.figure):'')+'<span class="w-title">'+esc(p.title)+'</span>'+(p.summary?'<span class="n-detail">'+para(p.summary)+'</span>':'')+'</div>'+
    (p.reason?'<p class="n-notes">“'+esc(p.reason)+'”</p>':'')+
    '<div class="n-facts">'+facts.map(([k,v])=>'<div><span class="eyebrow lime">'+k+'</span><span>'+esc(v)+'</span></div>').join('')+'</div>'+
    (draft&&p.canSecond?'<div class="n-pad"><button type="button" class="n-wide" data-action="n-second">Second this proposal</button><p class="n-hint flush">Seconding opens it for everyone to vote and emails the group.</p></div>':'')+
    (open&&can('proposals')?sectionHead('Your vote',p.myVote?({for:'For',against:'Against',abstain:'Abstain'})[p.myVote]:'Not voted yet')+voteButtons(p,'ink')+'<p class="n-hint">You can change your vote until it closes. Votes are visible to members.</p>':'')+
    (!draft?sectionHead(open?'So far':'Result',open?(p.quorumMet?'Quorum met':p.voted+' of '+p.quorum+' to count'):resultText(p))+counts+(voters?'<div class="n-faces">'+voters+'</div>':''):'')+
    (shown('comments')?sectionHead('Discussion',p.comments.length+'')+'<div class="n-replies">'+(p.comments.length?replyList(p.comments):'<p class="w-none">No replies yet.</p>')+'</div>'+replyBox('proposal',p.id):'')+
    (p.canEdit&&!preview?'<details class="n-add"><summary>Edit this proposal</summary><form data-form="n-proposal-update">'+proposalForm(p)+'<button>Save</button></form></details>':'')+
    ((p.canWithdraw||p.canDelete)&&!preview?'<div class="n-danger">'+(p.canWithdraw?'<button type="button" data-action="n-withdraw">Withdraw</button>':'')+(p.canDelete?'<button type="button" data-action="n-pdelete">Delete</button>':'')+'</div>':''));
}

async function nightClick(action,d,button){
  if(action==='n-pvote'){await proposalsApi('vote',{proposal:d.proposal,vote:d.vote});if(document.querySelector('.wall:not(.night-page)'))await wallReload();else await refresh();tell(d.vote==='none'?'Vote cleared.':'Vote saved: '+({for:'For',against:'Against',abstain:'Abstain'})[d.vote]+'.');return true;}
  if(action==='n-second'){await proposalsApi('second',{proposal:route.id});await refresh();tell('Seconded. Voting is open and the group has been emailed.');return true;}
  if(action==='n-withdraw'){if(!confirm('Withdraw this proposal? Voting stops and it leaves the list.'))return true;await proposalsApi('withdraw',{proposal:route.id});location.hash='decisions';return true;}
  if(action==='n-pdelete'){if(!confirm('Delete this proposal, its votes and discussion? This can’t be undone.'))return true;await proposalsApi('delete',{proposal:route.id});location.hash='decisions';return true;}
  if(action==='n-propose'){proposing=true;document.querySelector('#results')?.remove();decisionsPage();document.querySelector('.n-pform input')?.focus();return true;}
  if(action==='n-propose-close'){proposing=false;document.querySelector('#results')?.remove();decisionsPage();return true;}
  if(action==='n-key'){if(signCode.length<6)await signDigits(signCode+d.key);return true;}
  if(action==='n-del'){signCode=signCode.slice(0,-1);welcome();return true;}
  if(action==='n-change'){signStep='email';signCode='';welcome();return true;}
  if(action==='n-compose'){composer=true;boardPage();return true;}
  if(action==='n-compose-close'){composer=false;boardPage();return true;}
  if(action==='n-dfilter'){decFilter=d.kind;document.querySelector('#results')?.remove();decisionsPage();return true;}
  if(action==='n-rsvp'){
    if(d.value==='no'){meeting.rsvpReason=true;rerenderMeeting();document.querySelector('[data-form=n-rsvp-no] textarea')?.focus();return true;}
    await api('rsvp',{status:d.value,reason:''},meeting.id);await reloadMeeting();tell('Saved: '+rsvpLabels[d.value]+'.');return true;
  }
  if(action==='n-rsvp-cancel'){meeting.rsvpReason=false;rerenderMeeting();return true;}
  if(action==='n-going'){await eventsApi('going',{event:d.event,going:d.going==='true'});if(document.querySelector('.wall:not(.night-page)'))await wallReload();else await refresh();tell(d.going==='true'?'You’re going.':'Taken off the list.');return true;}
  if(action==='n-checkin'){await groupApi('checkin',{in:d.in==='true'});if(document.querySelector('.wall:not(.night-page)'))await wallReload();else await refresh();tell(d.in==='true'?'You’re in today. See you in the studio.':'Checked out.');return true;}
  if(action==='n-plus'){await postsApi('plus',{post:d.post,plus:d.plus==='true'});await refresh();return true;}
  if(action==='n-pfilter'){postFilter=d.tag;boardPage();return true;}
  if(action==='n-mfilter'){memberFilter=d.role;directoryPage();document.querySelectorAll('[data-action=n-mfilter]').forEach(b=>b.classList.toggle('on',b.dataset.role===memberFilter));return true;}
  return false;
}
function rerenderMeeting(){const box=document.querySelector('.n-meet');if(box&&route.page==='meetings')box.outerHTML=meetingBody();else meetingView();}
async function reloadMeeting(){meeting=asMember(await api('',undefined,meeting.id));if(route.page==='meetings'){group=await groupApi();meetingsPage();}else meetingView();}

async function show(){
  document.body.classList.remove('night');
  if(!group.me&&route.page!=='meeting'){welcome();return;}
  if((route.page==='organize'||route.page==='members')&&!organizer()){location.hash='';return;}
  switch(route.page){
    case 'organize': group=await groupApi('',undefined,{view:'organize'}); header(); organize(); return;
    case 'members': members(); return;
    case 'decisions': decisionsData=(await groupApi('',undefined,{view:'decisions'})).decisions; if(shown('proposals')){const r=await proposalsApi();proposalKinds=r.kinds;proposalData=r;} document.querySelector('#results')?.remove(); decisionsPage(); return;
    case 'proposal': {const r=await proposalsApi('',undefined,{proposal:route.id});proposalKinds=r.kinds;proposal=r.proposal;document.title=proposal.title+' · '+group.group;proposalPage();return;}
    case 'events': {const r=await eventsApi();eventKinds=r.kinds;eventList=preview?{upcoming:r.upcoming.filter(e=>!e.hidden),past:r.past.filter(e=>!e.hidden)}:r;eventsPage();return;}
    case 'event': {
      const r=await eventsApi('',undefined,{event:route.id});eventKinds=r.kinds;event=r.event;document.title=event.title+' · '+group.group;
      if(preview)event={...event,canEdit:false};
      const manageEvent=(route.manage||(organizer()&&!route.view))&&event.canEdit;
      route.manage=manageEvent;
      if(manageEvent)eventManage();else eventView();
      return;
    }
    case 'calls': {const r=await callsApi();callKinds=r.kinds;callList=preview?{open:r.open.filter(c=>!c.hidden),closed:r.closed.filter(c=>!c.hidden)}:r;callsPage();return;}
    case 'call': {const r=await callsApi('',undefined,{call:route.id});callKinds=r.kinds;call=r.call;document.title=call.title+' · '+group.group;callPage();return;}
    case 'post': post=(await postsApi('',undefined,{post:route.id})).post; document.title=post.title+' · '+group.group; postPage(); return;
    case 'meeting': {
      meeting=asMember(await api());document.title=meeting.title+' · '+group.group;
      const manageMeeting=(route.manage||(organizer()&&!route.view))&&meeting.admin&&!preview;
      route.manage=manageMeeting;
      if(manageMeeting){if(!draft.length)draft=meeting.agenda.map(item=>({...item}));meetingManage();}
      else meetingView();
      return;
    }
    case 'me': postList=shown('posts')?(await postsApi()).posts:[]; wallStart(); return;
    case 'meetings': meetingsPage(); return;
    case 'board': postList=shown('posts')?(await postsApi()).posts:[]; boardPage(); return;
    case 'settings': settingsPage(); return;
    case 'group': directory=(await groupApi('',undefined,{view:'directory'})).directory; directoryPage(); return;
    default:
      if(organizer()){route.page='organize';group=await groupApi('',undefined,{view:'organize'});header();organize();return;}
      postList=shown('posts')?(await postsApi()).posts:[]; wallStart();
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
root.addEventListener('input',event=>{if(event.target.id==='n-code'){signDigits(event.target.value);return;}const f=event.target.closest('form');if(f?.matches('.n-composer,.n-replybox')){const b=f.querySelector('.n-pinit,.n-replybox button');if(b)b.disabled=!f.querySelector(f.matches('.n-composer')?'input':'textarea').value.trim();}if(event.target.id==='search')decisionsPage();if(event.target.id==='n-q'){memberQuery=event.target.value;directoryPage();}});
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
    if((kind?.startsWith('w-')||kind?.startsWith('n-'))&&await wallSubmit(kind,fields))return;
    let result={};
    switch(kind){
      case 'signin': result=await groupApi('signin',{email:fields.email}); form.outerHTML=codeForm(fields.email); tell(result.notice); document.querySelector('[data-form=code] input[name=code]')?.focus(); return;
      case 'code': await groupApi('code',{email:fields.email,code:fields.code}); location.reload(); return;
      case 'join': result=await groupApi('join',fields); form.reset(); tell(result.notice); return;
      case 'setup': await groupApi('setup',fields); location.href='/'; return;
      case 'profile': await groupApi('profile',{name:fields.name,medium:fields.medium,emails:fields.email==='none'?'none':'all',digest:fields.email==='none'?undefined:fields.email}); await refresh(); tell('Settings saved.'); return;
      case 'add-members': result=await groupApi('add',{people:fields.people,role:data.has('organizer')?'organizer':'member'}); await refresh(); tell(result.notice); return;
      case 'promote': result=await groupApi('role',{member:fields.member,role:'organizer'}); await refresh(); tell(result.notice); return;
      case 'features': await groupApi('features',fields); await refresh(); tell('Saved. Members see the change right away.'); return;
      case 'post': {const created=await postsApi('create',fields); location.hash='post/'+created.id; return;}
      case 'comment': await postsApi('comment',{kind:form.dataset.kind,target:form.dataset.target,body:fields.body}); await refresh(); tell('Reply posted.'); return;
      case 'new-meeting': {const created=await api('',fields,''); location.hash=created.id+'/manage'; return;}
      case 'event-create': case 'event-update': {
        const payload={...fields,duration:minutesBetween(fields.local,fields.ends)||undefined};
        if(kind==='event-create'){const created=await eventsApi('create',payload);location.hash='event/'+created.id+'/manage';return;}
        await eventsApi('update',{...payload,event:route.id}); await refresh(); tell('Saved.'); return;
      }
      case 'call-create': {const created=await callsApi('create',fields);location.hash='call/'+created.id;return;}
      case 'call-update': await callsApi('update',{...fields,call:route.id}); await refresh(); tell('Saved.'); return;
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
    if(action.startsWith('w-')&&await wallClick(action,d))return;
    if(action.startsWith('n-')&&await nightClick(action,d,button))return;
    if(action==='signout'){setPreview(false);await groupApi('signout',{});location.href='/';return;}
    if(action==='copy'){const f=document.querySelector(d.target);f.select();try{await navigator.clipboard.writeText(f.value);tell('Link copied.');}catch{tell('Link selected. Copy it from the field.');}return;}
    if(action==='feed'){
      if(group.feedUrl&&!confirm('Make a new link? The old one will stop working in calendars that use it.'))return;
      group.feedUrl=(await groupApi('feed',{})).feedUrl;settingsPage();tell('Your calendar link is ready.');return;
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
    if(action==='install'){if(installPrompt){installPrompt.prompt();installPrompt=null;}return;}
    if(action==='install-dismiss'){try{localStorage.setItem('tp-install','no');}catch{}button.closest('section')?.remove();return;}
    if(action==='member-title'){const t=prompt('Role shown in the member directory (like Committee or Treasurer). Leave empty to clear.',d.title||'');if(t===null)return;await groupApi('title',{member:d.member,title:t});await refresh();tell(t.trim()?'Role saved.':'Role cleared.');return;}
    if(action==='call-filter'){callFilter=d.kind;callsPage();return;}
    if(action==='interest'){await callsApi('interest',{call:d.call||route.id,status:d.status});await refresh();tell(d.status==='none'?'Cleared.':'Saved: '+interestLabels[d.status]+'.');return;}
    if(action==='call-hide'){await callsApi('hide',{call:route.id,hidden:d.hidden==='true'});await refresh();tell('Saved.');return;}
    if(action==='call-delete'){if(!confirm('Delete “'+call.title+'” and its discussion? This can’t be undone.'))return;await callsApi('delete',{call:route.id});location.hash='calls';return;}
    if(action==='event-hide'){await eventsApi('hide',{event:route.id,hidden:d.hidden==='true'});await refresh();tell('Saved.');return;}
    if(action==='event-delete'){
      if(!confirm('Delete “'+event.title+'”? Its sign-up slots and discussion will be removed. This can’t be undone.'))return;
      await eventsApi('delete',{event:route.id,notify:!!document.querySelector('#notify-cancel')?.checked});location.hash='events';return;
    }
    if(action==='action-done'){
      await request('/api/meeting',{meeting:d.meeting,action:'action-done'},{action:d.item,done:d.done==='true'});
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
