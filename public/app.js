const root=document.querySelector('#app'), status=document.querySelector('#status');
const [id='',secret]=location.hash.slice(1).split('/');
const categories=['Discussion','Decision','Update'];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let meeting, draft=[], editing='';
const trap='<label class="trap" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>';
const options=selected=>categories.map(kind=>'<option'+(selected===kind?' selected':'')+'>'+kind+'</option>').join('');
const publicUrl=()=>meeting?.appUrl||location.origin;
const invite=()=>publicUrl()+'/#'+id;
const tell=message=>status.textContent=message||'';
const zone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
const zones=()=>{try{return Intl.supportedValuesOf('timeZone');}catch{return [];}};
async function api(action='',payload){
  const headers={};
  if(secret)headers.Authorization='Bearer '+secret;
  if(payload!==undefined)headers['Content-Type']='application/json';
  const query=new URLSearchParams({meeting:id,action});
  const response=await fetch('/api/meeting?'+query,{method:payload===undefined?'GET':'POST',headers,body:payload===undefined?undefined:JSON.stringify(payload)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error);
  return data;
}
function hero(title,subtitle,badge='',extra=''){
  return '<section class="hero">'+(badge?'<span class="mono phase">'+badge+'</span>':'')+'<h1>'+esc(title)+'</h1>'+(subtitle?'<p>'+esc(subtitle)+'</p>':'')+extra+'</section>';
}
function home(){
  root.innerHTML=hero('Open Floor','Make an agenda together before you meet.')+
  '<form class="panel" data-form="create"><h2>Create a meeting</h2><label>Meeting name<input name="title" required maxlength="100" placeholder="Artist group meeting"></label><label>Date and time <small>(optional, you can set an exact time later)</small><input name="schedule" maxlength="120" placeholder="Thursday, 7 pm · gallery"></label><label>Organizer access key<input type="password" name="organizerKey" maxlength="256" required autocomplete="off"></label><button>Create meeting</button></form>';
}
function topic(item,open){
  if(editing===item.id)return '<form class="topic" data-form="topic-edit" data-topic="'+item.id+'"><label>Topic<input name="label" maxlength="120" required value="'+esc(item.label)+'"></label><label>Details<textarea name="detail" maxlength="650">'+esc(item.detail)+'</textarea></label><label>Type<select name="kind">'+options(item.kind)+'</select></label><div class="actions"><button>Save topic</button><button type="button" class="alt" data-action="cancel-edit">Cancel</button></div></form>';
  const counts=item.up!==null?'<span>👍 '+item.up+' · 👎 '+item.down+'</span>':'';
  const tags=(item.own?'<span class="tag">Your topic</span>':'')+(item.hidden?'<span class="tag">Hidden from participants</span>':'');
  const votes=open&&!item.own&&!item.hidden?'<div class="votes"><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="1" aria-pressed="'+(item.mine>0)+'" aria-label="Vote up: '+esc(item.label)+'">👍 Up</button><button type="button" data-action="cast" data-topic="'+item.id+'" data-value="-1" aria-pressed="'+(item.mine<0)+'" aria-label="Vote down: '+esc(item.label)+'">👎 Down</button></div>':'';
  const tools=meeting.admin?'<div class="actions"><button type="button" class="alt small" data-action="edit-topic" data-topic="'+item.id+'">Edit</button><button type="button" class="alt small" data-action="hide-topic" data-topic="'+item.id+'" data-hidden="'+!item.hidden+'">'+(item.hidden?'Show':'Hide')+'</button><button type="button" class="alt small" data-action="delete-topic" data-topic="'+item.id+'">Delete</button></div>':'';
  return '<div class="topic'+(item.hidden?' hidden-topic':'')+'"><strong>'+esc(item.label)+'</strong><div class="mono"><span class="tag">'+esc(item.kind)+'</span>'+tags+counts+'</div>'+(item.detail?'<p>'+esc(item.detail)+'</p>':'')+votes+tools+'</div>';
}
function signup(){
  if(!meeting.emailEnabled)return '';
  return '<form class="panel" data-form="subscribe"><h2>Get updates by email</h2><p class="muted">New topics once a day, voting with one tap, the agenda with a calendar invite, and a reminder before the meeting. Unsubscribe anytime.</p><label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label>'+trap+'<button>Send me updates</button></form>';
}
function scheduleForm(){
  const list=zones(), tz=meeting.startsAt?meeting.timezone:zone();
  return '<form data-form="schedule" class="draft"><h2>Date and time</h2><p class="muted">Set an exact time to add calendar invites and a reminder email the day before.</p>'+
    '<div class="row"><label>Starts<input type="datetime-local" name="local" value="'+esc(meeting.local)+'"></label><label>Time zone<input name="timezone" list="zones" value="'+esc(tz)+'" required></label></div>'+
    '<datalist id="zones">'+list.map(z=>'<option value="'+esc(z)+'">').join('')+'</datalist>'+
    '<div class="row"><label>Length (minutes)<input type="number" name="duration" min="5" max="600" value="'+esc(meeting.duration||60)+'"></label><label>Place or video link<input name="location" maxlength="200" value="'+esc(meeting.location)+'"></label></div>'+
    '<label>Note shown under the title <small>(optional)</small><input name="schedule" maxlength="120" value="'+esc(meeting.schedule)+'"></label>'+
    (meeting.emailEnabled?'<label><input type="checkbox" name="notify" checked> Email the list if the time changes</label>':'')+'<button>Save date and time</button></form>';
}
function emailList(){
  if(!meeting.emailEnabled)return '<div class="draft"><h2>Email list</h2><p class="muted">Email updates are not set up yet. See the README to connect an email service.</p></div>';
  const subs=meeting.subscribers||[], active=subs.filter(s=>s.status==='active').length;
  const label={active:'Confirmed',pending:'Waiting for confirmation',unsubscribed:'Unsubscribed'};
  return '<div class="draft"><h2>Email list</h2><p class="muted">'+active+' confirmed. Everyone gets a confirmation email first, so nobody is added without agreeing. New topics go out in a daily digest; voting, the agenda and a reminder go out automatically.</p>'+
    (subs.length?'<ul class="subs">'+subs.map(s=>'<li><span>'+esc(s.email)+' <span class="muted">· '+label[s.status]+'</span></span><button type="button" class="alt" data-action="unlist" data-email="'+esc(s.email)+'">Remove</button></li>').join('')+'</ul>':'')+
    '<form data-form="invite"><label>Invite people <small>(emails separated by commas or new lines)</small><textarea name="emails" maxlength="20000"></textarea></label><button>Send invitations</button></form>'+
    '<div class="actions">'+(meeting.agenda.length?'<button type="button" class="alt" data-action="mail-agenda">Email agenda again</button>':'')+(meeting.notes?'<button type="button" class="alt" data-action="mail-outcomes">Email outcomes</button>':'')+'</div></div>';
}
function organizer(){
  return '<section class="panel admin"><h2>Organizer</h2><p class="muted">Bookmark this organizer page. Share the participant link so people can open the meeting without your editing controls.</p>'+(publicUrl()!==location.origin?'<p class="status">You’re on a private Vercel address that asks people to log in. <a href="'+esc(publicUrl()+'/'+location.hash)+'">Open this page on the public address</a> and bookmark that instead.</p>':'')+'<label>Participant link<input readonly id="invite" value="'+esc(invite())+'"></label><div class="actions"><button data-action="copy" class="alt">Copy participant link</button>'+
    (meeting.phase!=='collect'?'<button data-action="collect" class="alt">Reopen submissions</button>':'')+
    (meeting.phase==='collect'&&meeting.topics.length?'<button data-action="vote" class="alt">Close submissions, final vote</button>':'')+'</div>'+
    scheduleForm()+emailList()+
    '<form data-form="agenda" class="draft"><h2>Build the agenda</h2><p class="muted">Edit the suggested order, make room for urgent items, and publish when ready. Publishing closes submissions and voting'+(meeting.emailEnabled?' and emails the agenda to the list':'')+'.</p><div class="actions"><button type="button" data-action="suggest" class="alt" '+(meeting.topics.length?'':'disabled')+'>Use top three topics</button><button type="button" data-action="add" class="alt">Add agenda item</button></div><div id="draft"></div><button '+(draft.length?'':'disabled')+'>Publish agenda</button></form>'+
    (meeting.agenda.length?'<form data-form="notes" class="draft"><h2>Meeting outcomes</h2><label>Decisions and next steps<textarea name="notes" maxlength="7000" placeholder="Action · who will do it · by when">'+esc(meeting.notes)+'</textarea></label><button>Save outcomes</button></form>':'')+'</section>';
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
  const cal=meeting.startsAt?'<p class="when"><a href="/api/calendar?meeting='+id+'">Add to calendar</a>'+(meeting.when&&meeting.schedule?' · '+esc(meeting.schedule):'')+'</p>':'';
  root.innerHTML=hero(meeting.title,subtitle,{collect:'Topics and voting open',vote:'Final vote',agenda:'Agenda published'}[meeting.phase],cal)+
    (meeting.phase==='agenda'?'<section class="panel"><h2>Agenda</h2><p class="mono">'+meeting.agenda.reduce((total,item)=>total+item.minutes,0)+' minutes</p>'+meeting.agenda.map(item=>'<div class="topic"><div class="mono"><span class="tag">'+esc(item.kind)+'</span>'+item.minutes+' min</div><strong>'+esc(item.label)+'</strong>'+(item.detail?'<p>'+esc(item.detail)+'</p>':'')+'</div>').join('')+'</section>':'')+
    (meeting.notes?'<section class="panel"><h2>Decisions and next steps</h2><div class="note">'+esc(meeting.notes)+'</div></section>':'')+
    (meeting.phase==='collect'?'<form class="panel" data-form="topic"><h2>Suggest a topic</h2><p class="muted">What should we make time for? Your topic will be visible to everyone with the meeting link.</p><label>Topic<input name="label" maxlength="120" required></label><label>What would you like to happen? <small>(optional)</small><textarea name="detail" maxlength="650"></textarea></label><label>Type<select name="kind">'+options('Discussion')+'</select></label>'+trap+'<button>Submit topic</button></form>':'')+
    (open?'<section class="panel"><h2>Submitted topics</h2>'+(meeting.topics.length?'<p class="muted">Vote 👍 or 👎 on any topic. Tap again to take your vote back.</p>'+meeting.topics.map(item=>topic(item,true)).join(''):'<p class="muted">No topics yet.</p>')+'</section>':'')+
    (open?signup():'')+(meeting.admin?organizer():'');
  drawDraft();
}
async function refresh(){
  if(meeting.admin)readDraft();
  const keep=draft;
  meeting=await api();
  draft=keep;
  render();
}
async function load(){
  if(!id){home();return;}
  meeting=await api();
  draft=meeting.agenda.map(item=>({...item}));
  render();
}
async function perform(button,task){
  if(button)button.disabled=true;
  tell('');
  try{await task();}catch(error){tell(error.message);}
  finally{if(button?.isConnected)button.disabled=false;}
}
root.addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.target, data=new FormData(form);
  perform(event.submitter,async()=>{
    let result={};
    switch(form.dataset.form){
      case 'create': {
        const created=await api('',Object.fromEntries(data));
        location.hash=created.id+'/'+created.secret;
        return;
      }
      case 'topic': result=await api('topic',Object.fromEntries(data)); break;
      case 'subscribe': result=await api('subscribe',{email:data.get('email'),website:data.get('website')}); form.reset(); tell(result.notice); return;
      case 'topic-edit': result=await api('topic-edit',{topic:form.dataset.topic,...Object.fromEntries(data)}); editing=''; break;
      case 'invite': result=await api('invite',{emails:data.get('emails')}); break;
      case 'schedule': result=await api('schedule',{...Object.fromEntries(data),notify:data.has('notify')}); break;
      case 'agenda': readDraft(); result=await api('agenda',{agenda:draft}); break;
      case 'notes': result=await api('notes',{notes:data.get('notes')}); break;
    }
    const action=form.dataset.form;
    await refresh();
    if(action==='agenda')draft=meeting.agenda.map(item=>({...item})),drawDraft();
    tell([{topic:'Topic submitted.','topic-edit':'Topic saved.',invite:'',schedule:'Date and time saved.',agenda:'Agenda published.',notes:'Outcomes saved.'}[action],result.notice].filter(Boolean).join(' '));
  });
});
root.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');
  if(!button)return;
  const action=button.dataset.action;
  perform(button,async()=>{
    if(action==='copy'){
      const field=document.querySelector('#invite');
      field.select();
      if(navigator.clipboard){try{await navigator.clipboard.writeText(field.value);tell('Participant link copied.');return;}catch{}}
      tell('Participant link selected. Copy it from the field.');
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
      tell(button.dataset.hidden==='true'?'Topic hidden. Participants no longer see it.':'Topic visible again.');
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
    if(action==='unlist'){
      if(!confirm('Remove '+button.dataset.email+' from the email list?'))return;
      await api('remove',{email:button.dataset.email});
      await refresh();
      tell('Removed.');
      return;
    }
    if(action==='mail-agenda'||action==='mail-outcomes'){
      const result=await api('email',{kind:action.slice(5)});
      tell(result.notice);
      return;
    }
    readDraft();
    if(action==='collect'||action==='vote'){
      const result=await api('phase',{phase:action});
      await refresh();
      tell([action==='vote'?'Submissions closed. Final vote is open.':'Submissions are open.',result.notice].filter(Boolean).join(' '));
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
load().catch(error=>{root.innerHTML=hero('Meeting unavailable','Check the meeting link or return to Open Floor.');tell(error.message);});
