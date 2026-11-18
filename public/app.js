const root=document.querySelector('#app'), status=document.querySelector('#status'), who=document.querySelector('#who');
const [route='',secret]=location.hash.slice(1).split('/');
const id=/^[a-f0-9-]{36}$/.test(route)?route:'';
const categories=['Discussion','Decision','Update'];
const repeatLabels={'':'Does not repeat',weekly:'Every week',biweekly:'Every two weeks',monthly:'Every month (same weekday)'};
const rsvpLabels={yes:'Going',maybe:'Maybe',no:'Can’t make it'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let group, meeting, postList=[], post, draft=[], editing='';
const postId=route==='post'&&/^[a-f0-9-]{36}$/.test(secret||'')?secret:'';
const trap='<label class="trap" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>';
const options=selected=>categories.map(kind=>'<option'+(selected===kind?' selected':'')+'>'+kind+'</option>').join('');
const publicUrl=()=>meeting?.appUrl||location.origin;
const invite=()=>publicUrl()+'/#'+id;
const tell=message=>status.textContent=message||'';
const zone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
const zones=()=>{try{return Intl.supportedValuesOf('timeZone');}catch{return ['UTC'];}};
const zoneSelect=selected=>{const list=zones();if(!list.includes(selected))list.unshift(selected);return '<select name="timezone">'+list.map(z=>'<option'+(z===selected?' selected':'')+'>'+esc(z)+'</option>').join('')+'</select>';};
const repeatSelect=selected=>'<select name="repeat">'+Object.entries(repeatLabels).map(([v,l])=>'<option value="'+v+'"'+(v===(selected||'')?' selected':'')+'>'+l+'</option>').join('')+'</select>';

async function call(path,params,payload){
  const headers={};
  if(secret&&id&&!postId)headers.Authorization='Bearer '+secret;
  if(payload!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(path+'?'+new URLSearchParams(params),{method:payload===undefined?'GET':'POST',headers,body:payload===undefined?undefined:JSON.stringify(payload)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error);
  return data;
}
const api=(action='',payload)=>call('/api/meeting',{meeting:id,action},payload);
const groupApi=(action='',payload)=>call('/api/group',{action},payload);
const postsApi=(action='',payload,params={})=>call('/api/posts',{action,...params},payload);
const ago=ms=>{const m=Math.round((Date.now()-ms)/60000);return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'});};
const para=text=>esc(text).replace(/\n/g,'<br>');
function comments(list,{kind,target,form=true,small=false}={}){
  const org=group?.me?.role==='organizer';
  return (list.length?'<ul class="comments'+(small?' small':'')+'">'+list.map(c=>'<li'+(c.hidden?' class="hidden-topic"':'')+'><div class="meta"><strong>'+esc(c.author)+'</strong> · '+ago(c.created)+(c.via==='email'?' · by email':'')+(c.hidden?' · hidden':'')+((c.mine||org)?' <button type="button" class="link" data-action="delete-comment" data-comment="'+c.id+'">Delete</button>':'')+'</div><div class="body">'+para(c.body)+'</div></li>').join('')+'</ul>':'')+
    (form?'<form class="reply" data-form="comment" data-kind="'+kind+'" data-target="'+target+'"><label><span class="sr">Your reply</span><textarea name="body" maxlength="3000" required placeholder="Write a reply…"></textarea></label><button>Reply</button></form>':'');
}
function hero(title,subtitle,badge='',extra=''){
  return '<section class="hero">'+(badge?'<span class="mono phase">'+badge+'</span>':'')+'<h1>'+esc(title)+'</h1>'+(subtitle?'<p>'+esc(subtitle)+'</p>':'')+extra+'</section>';
}
function header(){
  who.innerHTML=group?.me?esc(group.me.name||group.me.email)+(group.me.role==='organizer'?' · organizer':''):'<a href="/">Sign in</a>';
}

/* Signed out: sign in, join, first-time setup */
function welcome(){
  const setup='<form class="draft" data-form="setup"><label>Organizer key<input type="password" name="organizerKey" required autocomplete="off"></label><label>Your name<input name="name" maxlength="80" required></label><label>Your email<input type="email" name="email" required maxlength="254"></label><button>Set up and sign in</button></form>';
  root.innerHTML=hero(group.group,'Meetings, agendas and decisions for the group, in one place.')+
    (group.needsSetup?'<section class="panel admin"><h2>Set up the group</h2><p class="muted">No organizers yet. Enter the organizer key from Vercel to become the first organizer.</p>'+setup+'</section>':'')+
    '<form class="panel" data-form="signin"><h2>Sign in</h2><p class="muted">Members get a sign-in link by email. No password needed.</p><label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label><button>Email me a sign-in link</button></form>'+
    '<form class="panel" data-form="join"><h2>Join the group</h2><p class="muted">Ask to join. An organizer will approve you, and you’ll get an email.</p><label>Name<input name="name" required maxlength="80" autocomplete="name"></label><label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label>'+trap+'<button>Ask to join</button></form>'+
    (group.needsSetup?'':'<details class="panel"><summary>Organizer key</summary><p class="muted">Lost access? The organizer key from Vercel signs you in as an organizer.</p>'+setup+'</details>');
}

/* Signed in: dashboard */
function meetingCard(m){
  const chip=m.mine?'<span class="chip rsvp-'+m.mine+'">'+rsvpLabels[m.mine]+'</span>':(m.past?'':'<span class="chip todo">RSVP needed</span>');
  return '<a class="card" href="#'+m.id+'"><strong>'+esc(m.title)+'</strong><span class="muted">'+esc(m.when||'Date to be set')+(m.location?' · '+esc(m.location):'')+'</span><span class="mono">'+chip+(m.going?'<span>'+m.going+' going</span>':'')+'</span></a>';
}
function dashboard(){
  const me=group.me, org=me.role==='organizer', requests=(group.members||[]).filter(m=>m.status==='requested').length;
  root.innerHTML=hero(group.group,'Hi'+(me.name?', '+me.name:'')+'.')+
    '<section class="panel"><h2>Upcoming meetings</h2>'+(group.meetings.upcoming.length?group.meetings.upcoming.map(meetingCard).join(''):'<p class="muted">No meetings scheduled yet.</p>')+'</section>'+
    (org?'<section class="panel admin"><h2>Organizer</h2><div class="actions"><a class="button alt" href="#members">Members'+(requests?' · '+requests+' waiting':'')+'</a></div>'+
      '<form data-form="new-meeting" class="draft"><h2>New meeting</h2><p class="muted">Everyone on the member list gets an email with RSVP buttons.</p><label>Name<input name="title" required maxlength="100" placeholder="Monthly members meeting"></label>'+timeFields({timezone:zone(),duration:90})+'<button>Create and invite members</button></form></section>':'')+
    '<section class="panel"><h2>Posts</h2><p class="muted">Announcements, questions and news for the group. Everyone gets them by email and can reply from their inbox.</p>'+
      (postList.length?postList.map(p=>'<a class="card" href="#post/'+p.id+'"><strong>'+(p.pinned?'📌 ':'')+esc(p.title)+'</strong><span class="muted">'+esc(p.author)+' · '+ago(p.created)+(p.replies?' · '+p.replies+(p.replies===1?' reply':' replies'):'')+(p.hidden?' · hidden':'')+'</span>'+(p.excerpt?'<span>'+esc(p.excerpt)+(p.excerpt.length>=240?'…':'')+'</span>':'')+'</a>').join(''):'<p class="muted">No posts yet.</p>')+
      '<details class="draft"><summary>Write a post</summary><form data-form="post"><label>Title<input name="title" required maxlength="140"></label><label>Message<textarea name="body" maxlength="6000" rows="6"></textarea></label><button>Post to the group</button></form></details></section>'+
    (group.meetings.past.length?'<section class="panel"><h2>Past meetings</h2>'+group.meetings.past.map(meetingCard).join('')+'</section>':'')+
    settingsForm(me);
}
function settingsForm(me){
  const value=me.emails==='none'?'none':me.digest;
  const opt=(v,l,d)=>'<label class="pick"><input type="radio" name="email" value="'+v+'"'+(value===v?' checked':'')+'> <span><strong>'+l+'</strong><br><span class="muted">'+d+'</span></span></label>';
  return '<form class="panel" data-form="profile"><h2>Your settings</h2><label>Name<input name="name" maxlength="80" value="'+esc(me.name)+'"></label><fieldset class="stack"><legend>Email</legend>'+
    opt('instant','Everything right away','Each post and reply as it happens.')+opt('daily','Daily summary','One email a day with new posts, replies and topics.')+opt('weekly','Weekly summary','One email on Mondays.')+opt('none','Off','No emails at all, not even meeting invitations.')+
    '</fieldset><p class="muted">Meeting invitations, agendas and reminders always come right away unless email is off.</p><div class="actions"><button>Save</button><button type="button" class="alt" data-action="signout">Sign out</button></div></form>';
}
function postPage(){
  const p=post, org=group.me.role==='organizer';
  root.innerHTML=hero(p.title,p.author+' · '+ago(p.created)+(p.hidden?' · hidden':''),p.pinned?'Pinned':'','<p><a href="/">← Back</a></p>')+
    (p.body?'<section class="panel"><div class="note">'+para(p.body)+'</div></section>':'')+
    '<section class="panel"><h2>Replies</h2>'+comments(p.comments,{kind:'post',target:p.id})+'</section>'+
    ((org||p.mine)?'<section class="panel admin"><div class="actions">'+(org?'<button type="button" class="alt" data-action="pin-post" data-pinned="'+!p.pinned+'">'+(p.pinned?'Unpin':'Pin to top')+'</button><button type="button" class="alt" data-action="hide-post" data-hidden="'+!p.hidden+'">'+(p.hidden?'Show':'Hide')+'</button>':'')+'<button type="button" class="alt" data-action="delete-post">Delete post</button></div></section>':'');
}
function timeFields(m){
  return '<div class="row"><label>Starts<input type="datetime-local" name="local" value="'+esc(m.local||'')+'"></label><label>Time zone'+zoneSelect(m.timezone||zone())+'</label></div>'+
    '<div class="row"><label>Length (minutes)<input type="number" name="duration" min="5" max="600" value="'+esc(m.duration||60)+'"></label><label>Repeats'+repeatSelect(m.repeat)+'</label></div>'+
    '<label>Place or video link<input name="location" maxlength="200" value="'+esc(m.location||'')+'"></label>'+
    '<label>Note under the title <small>(optional)</small><input name="schedule" maxlength="120" value="'+esc(m.schedule||'')+'"></label>';
}

/* Organizers: members */
function members(){
  const list=group.members||[], requests=list.filter(m=>m.status==='requested'), rest=list.filter(m=>m.status!=='requested');
  const label={active:'Member',invited:'Invited, hasn’t joined yet'};
  const row=m=>'<li><span><strong>'+esc(m.name||m.email)+'</strong> <span class="muted">'+(m.name?esc(m.email)+' · ':'')+(m.role==='organizer'?'Organizer':label[m.status]||m.status)+(m.emails==='none'?' · emails off':'')+'</span></span><span class="actions">'+
    (m.status==='requested'?'<button type="button" class="small" data-action="approve" data-member="'+m.id+'">Approve</button><button type="button" class="alt small" data-action="decline" data-member="'+m.id+'">Decline</button>':
     (m.status==='active'?'<button type="button" class="alt small" data-action="role" data-member="'+m.id+'" data-role="'+(m.role==='organizer'?'member':'organizer')+'">'+(m.role==='organizer'?'Make member':'Make organizer')+'</button>':'')+
     (m.id!==group.me.id?'<button type="button" class="alt small" data-action="remove-member" data-member="'+m.id+'" data-name="'+esc(m.name||m.email)+'">Remove</button>':''))+'</span></li>';
  root.innerHTML=hero('Members',list.filter(m=>m.status==='active').length+' active members','','<p><a href="/">← Back to meetings</a></p>')+
    (requests.length?'<section class="panel admin"><h2>Waiting for approval</h2><ul class="subs">'+requests.map(row).join('')+'</ul></section>':'')+
    '<form class="panel" data-form="add-members"><h2>Add people</h2><p class="muted">One person per line, like <code>Ana Ruiz &lt;ana@example.org&gt;</code> or just an email. Each person gets an invitation to accept, so nobody is added without agreeing.</p><label>People<textarea name="people" maxlength="20000"></textarea></label><button>Send invitations</button></form>'+
    '<section class="panel"><h2>Download</h2><p class="muted">Spreadsheet files (CSV) that open in Excel, Numbers or Google Sheets.</p><div class="actions"><a class="button alt" href="/api/export?what=members">Members</a><a class="button alt" href="/api/export?what=meetings">Meetings and outcomes</a><a class="button alt" href="/api/export?what=attendance">Attendance</a></div></section>'+
    '<section class="panel"><h2>Member list</h2>'+(rest.length?'<ul class="subs">'+rest.map(row).join('')+'</ul>':'<p class="muted">No members yet.</p>')+'</section>';
}

/* Meeting page */
function topic(item,open){
  if(editing===item.id)return '<form class="topic" data-form="topic-edit" data-topic="'+item.id+'"><label>Topic<input name="label" maxlength="120" required value="'+esc(item.label)+'"></label><label>Details<textarea name="detail" maxlength="650">'+esc(item.detail)+'</textarea></label><label>Type<select name="kind">'+options(item.kind)+'</select></label><div class="actions"><button>Save topic</button><button type="button" class="alt" data-action="cancel-edit">Cancel</button></div></form>';
  const counts=item.up!==null?'<span>👍 '+item.up+' · 👎 '+item.down+'</span>':'';
  const tags=(item.own?'<span class="tag">Your topic</span>':'')+(item.hidden?'<span class="tag">Hidden from members</span>':'');
  const votes=open&&meeting.me&&!item.own&&!item.hidden?'<div class="votes"><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="1" aria-pressed="'+(item.mine>0)+'" aria-label="Vote up: '+esc(item.label)+'">👍 Up</button><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="-1" aria-pressed="'+(item.mine<0)+'" aria-label="Vote down: '+esc(item.label)+'">👎 Down</button></div>':'';
  const tools=meeting.admin?'<div class="actions"><button type="button" class="alt small" data-action="edit-topic" data-topic="'+item.id+'">Edit</button><button type="button" class="alt small" data-action="hide-topic" data-topic="'+item.id+'" data-hidden="'+!item.hidden+'">'+(item.hidden?'Show':'Hide')+'</button><button type="button" class="alt small" data-action="delete-topic" data-topic="'+item.id+'">Delete</button></div>':'';
  const talk=item.comments?.length?'<details class="talk"><summary>'+item.comments.length+(item.comments.length===1?' comment':' comments')+'</summary>'+comments(item.comments,{form:false,small:true})+'</details>':'';
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
function attendance(){
  const a=meeting.attendance;
  return '<div class="draft"><h2>Attendance</h2><p>'+a.going.length+' going · '+a.maybe.length+' maybe · '+a.declined.length+' can’t make it · '+a.noAnswer.length+' haven’t answered</p>'+
    (a.declined.length?'<h3>Can’t make it</h3><ul class="subs">'+a.declined.map(d=>'<li><span><strong>'+esc(d.name)+'</strong> <span class="muted">'+esc(d.reason)+'</span></span></li>').join('')+'</ul>':'')+
    (a.noAnswer.length?'<h3>Haven’t answered</h3><p class="muted">'+esc(a.noAnswer.join(', '))+'</p><div class="actions"><button type="button" class="alt" data-action="nudge">Email a reminder to people who haven’t answered</button></div>':'')+'</div>';
}
function organizer(){
  return '<section class="panel admin"><h2>Organizer</h2><label>Meeting link<input readonly id="invite" value="'+esc(invite())+'"></label><div class="actions"><button data-action="copy" class="alt">Copy link</button>'+
    (meeting.phase!=='collect'?'<button data-action="collect" class="alt">Reopen submissions</button>':'')+
    (meeting.phase==='collect'&&meeting.topics.length?'<button data-action="phase-vote" class="alt">Close submissions, final vote</button>':'')+'</div>'+
    attendance()+
    '<form data-form="schedule" class="draft"><h2>Meeting details</h2><label>Name<input name="title" maxlength="100" required value="'+esc(meeting.title)+'"></label>'+timeFields(meeting)+
    '<label class="check"><input type="checkbox" name="notify" checked> Email members if the time changes</label><button>Save details</button></form>'+
    '<form data-form="agenda" class="draft"><h2>Build the agenda</h2><p class="muted">Edit the suggested order, make room for urgent items, and publish when ready. Publishing closes submissions and voting and emails the agenda to members.</p><div class="actions"><button type="button" data-action="suggest" class="alt" '+(meeting.topics.length?'':'disabled')+'>Use top three topics</button><button type="button" data-action="add" class="alt">Add agenda item</button></div><div id="draft"></div><button '+(draft.length?'':'disabled')+'>Publish agenda</button></form>'+
    (meeting.agenda.length?'<form data-form="notes" class="draft"><h2>Meeting outcomes</h2><label>Decisions and next steps<textarea name="notes" maxlength="7000" placeholder="Action · who will do it · by when">'+esc(meeting.notes)+'</textarea></label><div class="actions"><button>Save outcomes</button>'+(meeting.notes?'<button type="button" class="alt" data-action="mail-outcomes">Email outcomes</button>':'')+'<button type="button" class="alt" data-action="mail-agenda">Email agenda again</button></div></form>':'')+'</section>';
}
function drawDraft(){
  const container=document.querySelector('#draft');
  if(!container)return;
  container.innerHTML=draft.map((item,i)=>'<div class="draft" data-row><label>Topic<input name="label" required maxlength="120" value="'+esc(item.label)+'"></label><label>What needs to happen?<textarea name="detail" maxlength="650">'+esc(item.detail)+'</textarea></label><label>Type<select name="kind">'+options(item.kind)+'</select></label><label>Minutes<input name="minutes" type="number" min="1" max="120" required value="'+item.minutes+'"></label><div class="actions">'+(i?'<button type="button" class="alt" data-action="up" data-index="'+i+'">Move up</button>':'')+'<button type="button" class="alt" data-action="remove" data-index="'+i+'">Remove</button></div></div>').join('');
  container.nextElementSibling.disabled=!draft.length;
}
function readDraft(){
  draft=[...document.querySelectorAll('[data-row]')].map(row=>Object.fromEntries([...row.querySelectorAll('[name]')].map(field=>[field.name,field.value])));
}
function render(){
  const open=meeting.phase!=='agenda';
  const subtitle=meeting.when?meeting.when+(meeting.location?' · '+meeting.location:''):meeting.schedule;
  const extra='<p class="when">'+(meeting.startsAt?'<a href="/api/calendar?meeting='+id+'">Add to calendar</a>':'')+(meeting.when&&meeting.schedule?' · '+esc(meeting.schedule):'')+(meeting.repeat?' · '+repeatLabels[meeting.repeat]:'')+'</p><p><a href="/">← All meetings</a></p>';
  const canSuggest=meeting.phase==='collect'&&meeting.me;
  root.innerHTML=hero(meeting.title,subtitle,{collect:'Topics and voting open',vote:'Final vote',agenda:'Agenda published'}[meeting.phase],extra)+
    rsvpPanel()+
    (meeting.phase==='agenda'?'<section class="panel"><h2>Agenda</h2><p class="mono">'+meeting.agenda.reduce((total,item)=>total+item.minutes,0)+' minutes</p>'+meeting.agenda.map(item=>'<div class="topic"><div class="mono"><span class="tag">'+esc(item.kind)+'</span>'+item.minutes+' min</div><strong>'+esc(item.label)+'</strong>'+(item.detail?'<p>'+esc(item.detail)+'</p>':'')+'</div>').join('')+'</section>':'')+
    (meeting.notes?'<section class="panel"><h2>Decisions and next steps</h2><div class="note">'+esc(meeting.notes)+'</div></section>':'')+
    (canSuggest?'<form class="panel" data-form="topic"><h2>Suggest a topic</h2><p class="muted">What should we make time for? Members see your topic and vote on it; you can’t vote on your own.</p><label>Topic<input name="label" maxlength="120" required></label><label>What would you like to happen? <small>(optional)</small><textarea name="detail" maxlength="650"></textarea></label><label>Type<select name="kind">'+options('Discussion')+'</select></label>'+trap+'<button>Submit topic</button></form>':'')+
    (open?'<section class="panel"><h2>Submitted topics</h2>'+(meeting.topics.length?(meeting.me?'<p class="muted">Vote 👍 or 👎 on any topic. Tap again to take your vote back.</p>':'')+meeting.topics.map(item=>topic(item,true)).join(''):'<p class="muted">No topics yet.</p>')+'</section>':'')+
    (meeting.me?'<section class="panel"><h2>Discussion</h2><p class="muted">Questions and notes about this meeting. You can also reply to any meeting email.</p>'+comments(meeting.discussion||[],{kind:'meeting',target:id})+'</section>':joinPrompt())+
    (meeting.admin?organizer():'');
  drawDraft();
}

async function refresh(){
  if(meeting?.admin)readDraft();
  const keep=draft;
  meeting=await api();
  draft=keep;
  render();
}
async function load(){
  group=await groupApi();
  header();
  if(id){
    meeting=await api();
    document.title=meeting.title+' · '+group.group;
    draft=meeting.agenda.map(item=>({...item}));
    render();
  }else if(route==='members'&&group.me?.role==='organizer'){members();}
  else if(postId&&group.me){post=(await postsApi('',undefined,{post:postId})).post;document.title=post.title+' · '+group.group;postPage();}
  else if(group.me){postList=(await postsApi()).posts;dashboard();}
  else welcome();
}
async function reloadGroup(){group=await groupApi();header();if(route==='members')return members();postList=(await postsApi()).posts;dashboard();}
async function reloadPost(){post=(await postsApi('',undefined,{post:postId})).post;postPage();}
async function perform(button,task){
  if(button)button.disabled=true;
  tell('');
  try{await task();}catch(error){tell(error.message);}
  finally{if(button?.isConnected)button.disabled=false;}
}

root.addEventListener('change',event=>{
  if(event.target.name==='status'&&event.target.closest('[data-form=rsvp]')){
    const reason=root.querySelector('[data-reason]');
    if(reason)reason.hidden=event.target.value==='yes';
  }
});
root.addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.target, data=new FormData(form), fields=Object.fromEntries(data), kind=form.dataset.form;
  perform(event.submitter,async()=>{
    let result={};
    switch(kind){
      case 'signin': result=await groupApi('signin',{email:fields.email}); form.reset(); tell(result.notice); return;
      case 'join': result=await groupApi('join',fields); form.reset(); tell(result.notice); return;
      case 'setup': await groupApi('setup',fields); location.href='/'; return;
      case 'profile': await groupApi('profile',{name:fields.name,emails:fields.email==='none'?'none':'all',digest:fields.email==='none'?undefined:fields.email}); await reloadGroup(); tell('Settings saved.'); return;
      case 'post': {const created=await postsApi('create',fields); location.hash='post/'+created.id; return;}
      case 'comment': {
        await postsApi('comment',{kind:form.dataset.kind,target:form.dataset.target,body:fields.body});
        if(postId){await reloadPost();}else{await refresh();}
        tell('Reply posted.'); return;
      }
      case 'add-members': result=await groupApi('add',{people:fields.people}); await reloadGroup(); tell(result.notice); return;
      case 'new-meeting': {
        const created=await api('',fields);
        location.hash=created.id;
        return;
      }
      case 'rsvp': result=await api('rsvp',{status:fields.status,reason:fields.reason}); break;
      case 'topic': result=await api('topic',fields); break;
      case 'topic-edit': result=await api('topic-edit',{topic:form.dataset.topic,...fields}); editing=''; break;
      case 'schedule': result=await api('schedule',{...fields,notify:data.has('notify')}); break;
      case 'agenda': readDraft(); result=await api('agenda',{agenda:draft}); break;
      case 'notes': result=await api('notes',{notes:fields.notes}); break;
    }
    await refresh();
    if(kind==='agenda')draft=meeting.agenda.map(item=>({...item})),drawDraft();
    tell([{rsvp:'RSVP saved.',topic:'Topic submitted.','topic-edit':'Topic saved.',schedule:'Details saved.',agenda:'Agenda published.',notes:'Outcomes saved.'}[kind],result.notice].filter(Boolean).join(' '));
  });
});
root.addEventListener('click',event=>{
  const button=event.target.closest('button[data-action]');
  if(!button)return;
  const action=button.dataset.action;
  perform(button,async()=>{
    if(action==='signout'){await groupApi('signout',{});location.href='/';return;}
    if(action==='delete-comment'){if(!confirm('Delete this comment?'))return;await postsApi('delete-comment',{comment:button.dataset.comment});postId?await reloadPost():await refresh();tell('Comment deleted.');return;}
    if(action==='delete-post'){if(!confirm('Delete this post and its replies?'))return;await postsApi('delete',{post:postId});location.href='/';return;}
    if(action==='pin-post'||action==='hide-post'){
      await postsApi(action==='pin-post'?'pin':'hide',{post:postId,pinned:button.dataset.pinned==='true',hidden:button.dataset.hidden==='true'});
      await reloadPost();tell('Saved.');return;
    }
    if(['approve','decline','role','remove-member'].includes(action)){
      if(action==='remove-member'&&!confirm('Remove '+button.dataset.name+' from the group?'))return;
      const result=await groupApi(action==='remove-member'?'remove':action,{member:button.dataset.member,role:button.dataset.role});
      await reloadGroup(); tell(result.notice); return;
    }
    if(action==='copy'){
      const field=document.querySelector('#invite');
      field.select();
      if(navigator.clipboard){try{await navigator.clipboard.writeText(field.value);tell('Link copied.');return;}catch{}}
      tell('Link selected. Copy it from the field.');
      return;
    }
    if(action==='edit-topic'||action==='cancel-edit'){
      if(meeting.admin)readDraft();
      editing=action==='edit-topic'?button.dataset.topic:'';
      render();
      return;
    }
    if(action==='hide-topic'){
      await api('topic-hide',{topic:button.dataset.topic,hidden:button.dataset.hidden==='true'});
      await refresh();
      tell(button.dataset.hidden==='true'?'Topic hidden. Members no longer see it.':'Topic visible again.');
      return;
    }
    if(action==='delete-topic'){
      if(!confirm('Delete this topic and its votes? This can’t be undone.'))return;
      await api('topic-delete',{topic:button.dataset.topic});
      await refresh();
      tell('Topic deleted.');
      return;
    }
    if(action==='cast'){
      const value=Number(button.dataset.value), current=meeting.topics.find(t=>t.id===button.dataset.topic)?.mine;
      await api('vote',{topic:button.dataset.topic,value:current===value?0:value});
      await refresh();
      tell(current===value?'Vote removed.':'Vote saved.');
      return;
    }
    if(action==='nudge'){const result=await api('nudge',{});tell(result.notice);return;}
    if(action==='mail-agenda'||action==='mail-outcomes'){
      const result=await api('email',{kind:action.slice(5)});
      tell(result.notice);
      return;
    }
    readDraft();
    if(action==='collect'||action==='phase-vote'){
      const phase=action==='collect'?'collect':'vote';
      const result=await api('phase',{phase});
      await refresh();
      tell([phase==='vote'?'Submissions closed. Final vote is open.':'Submissions are open.',result.notice].filter(Boolean).join(' '));
      return;
    }
    const i=Number(button.dataset.index);
    if(action==='suggest'){
      if(draft.length&&!confirm('Replace the current draft with the three highest-ranked topics?'))return;
      draft=meeting.topics.filter(t=>!t.hidden).slice(0,3).map(item=>({label:item.label,detail:item.detail,kind:item.kind,minutes:15}));
    }
    if(action==='add'&&draft.length<15)draft.push({label:'',detail:'',kind:'Discussion',minutes:10});
    if(action==='remove')draft.splice(i,1);
    if(action==='up')[draft[i-1],draft[i]]=[draft[i],draft[i-1]];
    drawDraft();
  });
});
window.addEventListener('hashchange',()=>location.reload());
load().catch(error=>{root.innerHTML=hero('Not available','Check the link, or go back to the start.')+'<p><a href="/">← Start</a></p>';tell(error.message);});
