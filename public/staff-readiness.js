import {readinessView,promptPreview,sastDay,addDays,visibleStay} from './stay-readiness-model.js';
const el=id=>document.getElementById(id);
const make=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
let rows=[],staff=null,properties=[],busy=false;
async function api(body){const r=await fetch('/api/staff-readiness',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Readiness unavailable');return data;}
function notice(text){el('readiness-notice').textContent=text;}
async function refresh(){rows=await api({action:'read'});if(!Array.isArray(rows))throw new Error('Invalid readiness response');render();}
function button(text,fn){const b=make('button',text);b.type='button';b.disabled=false; // Click handlers also enforce the shared in-flight guard.
b.addEventListener('click',fn);return b;}
async function write(b,body,onSuccess){if(busy)return;busy=true;b.disabled=true;notice('Saving…');try{const result=await api(body);await refresh();onSuccess?.(result);notice('Saved and audited. No messages sent.');}catch(e){notice(e.message+' No automatic retry. Reload saved readiness before trying again.');}finally{busy=false;b.disabled=false;}}
function render(){
 const now=new Date(),today=sastDay(now),horizon=el('readiness-window').value==='tomorrow'?addDays(today,1):el('readiness-window').value==='week'?addDays(today,7):today;
 const views=rows.map(r=>({...r,view:readinessView(r.booking,r.checkpoints,r.cleaning,now)}));
 const active=views.filter(r=>!r.view.cancelled);
 const counts=[['Arrivals today',active.filter(r=>r.booking.arrival===today).length],['Departures today',active.filter(r=>r.booking.departure===today).length],['Guests in house',active.filter(r=>r.booking.arrival<=today&&r.booking.departure>today&&r.booking.operational_status!=='checked_out').length],['Arrivals next 7 days',active.filter(r=>r.booking.arrival>=today&&r.booking.arrival<=addDays(today,7)).length],['Needs attention',active.filter(r=>r.view.attention.length).length],['Ready for arrival',active.filter(r=>r.booking.arrival>=today&&r.view.ready).length]];
 el('readiness-counts').replaceChildren(...counts.map(([label,count])=>{const n=make('article');n.className='card';n.append(make('strong',label),make('span',String(count)));return n;}));
 const shown=views.filter(r=>visibleStay(r.booking,r.view,horizon,today));
 el('readiness-stays').replaceChildren(...shown.map(r=>{
  const b=r.booking,v=r.view,card=make('article');card.className='readiness-stay';const property=properties.find(p=>p.slug===b.property_slug)?.name||b.property_slug;
  card.append(make('h3',`${property} · ${b.guest_name||'Guest not supplied'}`),make('p',`${b.arrival} → ${b.departure} · ${(Date.parse(b.departure)-Date.parse(b.arrival))/86400000} nights · ${b.source_channel||'Source unknown'} · ${b.operational_status||b.source_status}`));
  card.append(make('strong',v.cancelled?'CANCELLED/BLOCKED — no response actions':v.ready?'READY FOR ARRIVAL ✓':'ATTENTION / CHECKS PENDING'),make('p',v.attention.join(' · ')||'No current attention flags'));
  const quick=make('div');quick.className='readiness-quick';for(const i of (v.checkpoints.find(c=>c.checkpoint_key==='pre_arrival')?.items||[]))quick.append(make('span',`${i.status==='complete'?'✓':i.status==='needs_attention'?'⚠':'○'} ${i.label} · `));card.append(quick);
  card.append(make('p',`Guest contact: ${v.contact.route||'NO COMMUNICATION ROUTE'} · Email ${v.contact.email?'available':'missing'} · Mobile ${v.contact.mobile?'available':'missing'} · GHL ${v.contact.ghl}`));
  const next=rows.filter(x=>x.booking.id!==b.id&&x.booking.property_slug===b.property_slug&&x.booking.arrival>=b.departure&&!['cancelled','canceled'].includes(x.booking.source_status)).sort((a,z)=>a.booking.arrival.localeCompare(z.booking.arrival))[0];
  card.append(make('p',`Cleaner: ${r.cleaning?.state==='not_required'?'NOT REQUIRED (staff decision)':r.cleaning?.cleaner_name||'NOT ASSIGNED'} · Cleaning status: ${v.checkpoints.find(c=>c.checkpoint_key==='post_clean')?.effective_status||'not initialized'} · Expected cleaning: ${r.cleaning?.expected_cleaning_at?new Date(r.cleaning.expected_cleaning_at).toLocaleString('en-ZA',{timeZone:'Africa/Johannesburg'})+' SAST':r.cleaning?.state==='not_required'?'Not required':'Default-derived: departure 16:00 SAST'} · Next saved arrival: ${next?.booking.arrival||'Not in loaded window'}`));
  card.append(make('p',`Next checkpoint: ${v.next?.label||'None'}${v.next?' · '+(v.next.effective_status==='deferred'?'Deferred until ':v.next.effective_status+' · ')+new Date(v.next.deferred_until||v.next.due_at).toLocaleString('en-ZA',{timeZone:'Africa/Johannesburg'})+' SAST':''}`));
  if(staff.permissions.includes('operations.write')&&!v.cancelled){
   if(!r.checkpoints.length){const init=button('Initialize checklist',()=>write(init,{action:'generate',booking_id:b.id}));card.append(init);}
   const details=make('details'),summary=make('summary','Arrange cleaner / expected cleaning completion');details.append(summary);
   const form=make('form');form.method='post';
   const state=make('select');state.setAttribute('aria-label','Cleaning arrangement state');for(const [value,label] of [['unassigned','Cleaner not yet assigned'],['assigned','Cleaner assigned'],['not_required','Cleaning intentionally not required']]){const option=make('option',label);option.value=value;state.append(option);}state.value=r.cleaning?.state||'unassigned';
   const name=make('input');name.value=r.cleaning?.cleaner_name||'';name.maxLength=120;name.placeholder='Cleaner name (no payment)';name.setAttribute('aria-label','Cleaner name');
   const time=make('input');time.type='datetime-local';time.setAttribute('aria-label','Expected completion, South African time');if(r.cleaning?.expected_cleaning_at)time.value=new Date(Date.parse(r.cleaning.expected_cleaning_at)+7200000).toISOString().slice(0,16);
   const note=make('input');note.placeholder='Arrangement note / reason if not required';note.maxLength=2000;note.value=r.cleaning?.note||'';
   const fields=()=>{name.disabled=time.disabled=state.value!=='assigned';note.required=state.value==='not_required';};fields();state.addEventListener('change',fields);
   const save=make('button','Save arrangement');save.type='submit';
   form.append(state,name,time,note,save);form.addEventListener('submit',e=>{e.preventDefault();const assigned=state.value==='assigned';write(save,{action:'cleaner',booking_id:b.id,cleaning_state:state.value,cleaner_name:assigned?name.value:null,expected_cleaning_at:assigned&&time.value?time.value+':00+02:00':null,note:note.value});});details.append(form);card.append(details);
  }
  for(const c of v.checkpoints){const d=make('details');d.append(make('summary',`${c.label} · ${c.effective_status.replaceAll('_',' ')}${c.schedule_review?' · date change needs review':''}`));
   for(const i of c.items)d.append(make('p',`${i.status==='complete'?'✓':i.status==='needs_attention'?'⚠':'○'} ${i.label}`));
   d.append(make('p',c.note||''));
   if(staff.permissions.includes('operations.write')&&c.status!=='not_applicable'&&v.eligible){
    const output=make('div');
    const showPreview=async(replacePrompt=null)=>{
     if(busy)return;busy=true;preview.disabled=true;
     try{
      const response=await api({action:'preview',checkpoint_id:c.id,revision:c.revision,replace_prompt_id:replacePrompt});
      if(response.booking?.id!==b.id)throw new Error('Preview identity changed; reload saved readiness');
      const message=promptPreview(response.booking,response.checkpoint,response.property_name||property),pane=make('div');pane.className='prompt-preview';
      pane.append(make('h4',message.subject),make('pre',message.body),make('p','Simulation only. Actions expire in 10 minutes and require this signed-in staff session.'));
      if(response.replacement_required||!response.actions){
       pane.append(make('p','Actions expired or are unavailable after a server/session refresh. No new active set was silently created.'),button('Replace unavailable preview actions',()=>showPreview(response.prompt_id)));
      }else{
       const note=make('textarea');note.maxLength=2000;note.placeholder='Optional issue / correction note';pane.append(note);
       const status=make('p');status.setAttribute('role','status');pane.append(status);let submitted=false;
       for(const [a,label] of [['yes','SIMULATE YES — READY'],['no','SIMULATE NO — NEEDS ATTENTION'],['tomorrow','SIMULATE REMIND TOMORROW']]){
        const act=button(label,async()=>{if(submitted||busy)return;submitted=true;busy=true;for(const x of pane.querySelectorAll('button'))x.disabled=true;status.textContent='Saving…';
         try{const saved=await api({action:'respond',booking_id:b.id,action_token:response.actions[a],note:note.value});if(saved.saved!==true)throw new Error('Persistence not confirmed');await refresh();notice(saved.replayed?'Previously recorded response; no new change made. Current saved readiness reloaded.':'Response saved and audited. No email or guest message sent.');}
         catch(e){status.textContent=e.message+' Outcome may be uncertain. Reload to inspect; no automatic retry.';}
         finally{busy=false;}
        });pane.append(act);
       }
      }
      output.replaceChildren(pane);
     }catch(e){output.replaceChildren(make('p',e.message));notice(e.message);}finally{busy=false;preview.disabled=false;}
    };
    const preview=button('Preview internal prompt',()=>showPreview());d.append(preview,output);
   }
   card.append(d);
  }
  const messages=make('details');messages.append(make('summary','Guest communication schedule — delivery disabled'));
  for(const m of r.communications||[])messages.append(make('p',`${m.message_key} · ${m.route} · ${m.status} · ${m.scheduled_at}${m.status==='scheduled'&&Date.parse(m.scheduled_at)<=Date.now()?' · DUE (not sent)':''}`));
  if(!r.communications?.length)messages.append(make('p','No guest messages scheduled. No historical messages will be backfilled.'));card.append(messages);
  const history=make('details');history.append(make('summary','Response history (latest first)'));
  for(const h of r.history||[])history.append(make('p',`${new Date(h.created_at).toLocaleString('en-ZA',{timeZone:'Africa/Johannesburg'})} SAST · ${h.actor} · ${h.action} · ${h.note||''}`));
  card.append(history);return card;
 }));
 if(!shown.length)el('readiness-stays').append(make('p','No saved stays in this view. Check source health before relying on it.'));
}
globalThis.loadStayReadiness=async function(s,p){staff=s;properties=p;el('readiness').hidden=false;try{await refresh();notice('Internal readiness only. No emails, guest messages or payments enabled.');}catch(e){notice('Readiness unavailable: '+e.message+' The OPS-1 migration may still need staging validation.');}};
el('readiness-window').addEventListener('change',render);
el('readiness-reload').addEventListener('click',()=>{if(!busy)refresh().catch(e=>notice(e.message));});
setInterval(()=>{if(staff&&!busy&&!document.querySelector('.prompt-preview, details[open]')&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))render();},60000);
if(globalThis.currentOperationsStaff)globalThis.loadStayReadiness(...globalThis.currentOperationsStaff);
