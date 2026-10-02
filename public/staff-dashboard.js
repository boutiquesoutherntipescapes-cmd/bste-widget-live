const el=id=>document.getElementById(id);
let data; let epoch=0; let busy=false; let refreshFailed=false;
function node(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=String(text);if(cls)n.className=cls;return n;}
function localTime(value){return value?new Date(value).toLocaleString('en-ZA',{timeZone:'Africa/Johannesburg'})+' SAST':'Never';}
function warn(text){el('notice').textContent=text;}
async function api(body){const r=await fetch('/api/staff-operations',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
 const result=await r.json();if(!r.ok)throw new Error(result.error||'Operations data unavailable');return result;}
function reviewForm(row,type){const f=node('form',null,'review'); const select=node('select');
 const values=type==='operational'?['review_required','confirmed','checked_in','checked_out']:['unknown','unpaid','part_paid','deposit_paid','paid','channel_managed'];
 for(const value of values){const option=node('option',value.replaceAll('_',' '));option.value=value;select.append(option);}
 const selected=type==='operational'?row.operational_status:row.payment_status||'unknown';
 select.value=values.includes(selected)?selected:(type==='operational'?'review_required':'unknown');
 const label=node('label',type==='operational'?'Operational review':'Payment review');label.append(select);
 const reason=node('input');reason.required=true;reason.maxLength=2000;reason.placeholder='Reason / verified evidence reference';reason.setAttribute('aria-label','Reason or evidence reference');
 const button=node('button', 'Save review');button.type='submit';button.disabled=busy;
 f.append(label,reason,button);f.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;button.disabled=true;
  let saved=false;
  try{await api({action:type,booking_id:row.id,status:select.value,reason:reason.value});await load();saved=true;warn('Staff review saved and audited. Beds24 was not changed.');}
  catch(error){warn(error.message);}finally{busy=false;if(saved)render();else button.disabled=false;}});return f;}

function messageLabel(key){return ({
 booking_confirmation:'Booking confirmation',
 pre_arrival:'3 days before arrival',
 arrival_morning:'Arrival day · 09:00',
 arrival_evening_essentials:'Arrival day · 20:00',
 departure_eve:'Day before departure · 18:00',
 departure_morning:'Departure day · 08:00',
 post_stay:'Following day · 10:00'
})[key]||key.replaceAll('_',' ');}
function renderCommunications(){
 const select=el('communications-booking'), list=el('communications-list'), note=el('communications-note');
 if(!data?.communication_previews?.length){select.replaceChildren();list.replaceChildren();note.textContent='No communication previews are available.';return;}
 const current=select.value;
 select.replaceChildren(...data.communication_previews.map(p=>{
  const b=data.bookings.find(x=>x.id===p.booking_id);const o=node('option',`${p.guest_name||'Guest'} · ${b?.arrival||''} · ${b?.source_channel||'Unknown channel'}`);
  o.value=p.booking_id;return o;
 }));
 if(current&&data.communication_previews.some(p=>p.booking_id===current))select.value=current;
 const preview=data.communication_previews.find(p=>p.booking_id===select.value)||data.communication_previews[0];
 select.value=preview.booking_id;
 const b=data.bookings.find(x=>x.id===preview.booking_id);
 note.textContent=`${preview.guest_name||'Guest'} · ${b?.property_slug||''} · route determined from ${preview.source_channel||'source record'} · ${preview.enrollment_saved?'enrollment saved':'preview uses current time only; not enrolled'} · live sending disabled`;
 const enroll=el('communications-enroll'); enroll.disabled=busy||preview.enrollment_saved||!data.staff.permissions.includes('operations.write');
 enroll.textContent=preview.enrollment_saved?'Preview queue enrolled':'Enroll preview queue';
 list.replaceChildren(...preview.communications.map(m=>{
  const row=node('article',null,'communication-row');
  const top=node('div',null,'communication-top');
  top.append(node('strong',messageLabel(m.message_key)),node('span',m.status,'status-chip '+m.status));
  row.append(top,node('div',localTime(m.scheduled_at),'communication-time'),node('div',`Route: ${m.route}`,'communication-route'));
  if(m.reason)row.append(node('small',`Reason: ${m.reason.replaceAll('_',' ')}`));
  if(m.delivery_readiness){
   const gate=m.delivery_readiness.reason?m.delivery_readiness.reason.replaceAll('_',' '):(m.delivery_readiness.ready?'ready':'not ready');
   const timing=(m.delivery_readiness.timing_state||'unknown').replaceAll('_',' ');
   row.append(node('small',`Delivery readiness: ${gate} · timing: ${timing}`,'communication-readiness'));
  }
  if(preview.enrollment_saved&&m.id&&m.status==='scheduled'&&m.route!=='unresolved'&&data.staff.permissions.includes('operations.write')){
   const test=node('button','Send test copy to BSTE inbox','communication-test');test.type='button';test.disabled=busy;
   test.addEventListener('click',async()=>{if(busy)return;busy=true;test.disabled=true;warn('Sending a test copy to the BSTE inbox only. The guest queue will not be changed.');
    try{const result=await api({action:'test_communication',booking_id:preview.booking_id,communication_id:m.id});warn(result.ignored==='duplicate_test'?'This exact queue item was already test-sent; no duplicate email was sent.':'Test copy sent to the BSTE inbox. Guest sending remains disabled and the queue was not changed.');}
    catch(error){warn(error.message);}finally{busy=false;renderCommunications();}});
   row.append(test);
  }
  return row;
 }));
}

function render(){if(!data)return;
 el('properties').replaceChildren(...data.properties.map(p=>{const card=node('article',null,'card');card.append(node('strong',p.name),node('span',p.count,'count'),node('small','saved current / future records'));return card;}));
 const d=data.diagnostics,run=d.last_attempt;
 el('sync-state').textContent=`Last successful sync: ${localTime(d.last_success?.completed_at)} · Beds24 read: ${run?.source_read_status||'not run'} · Latest attempt: ${run?.status||'not run'}${run?.error_code?' ('+run.error_code+')':''}`;
 el('sync-counts').textContent=`Latest successful import: ${d.last_success?.imported_count??0} records. `+data.properties.map(p=>`${p.name}: ${d.last_success?.property_counts?.[p.slug]??0}`).join(' · ');
 el('refresh').disabled=busy||!data.staff.permissions.includes('sync.run');
 const shown=data.bookings.filter(b=>el('group').value==='all'||b.group===el('group').value);
 el('bookings').replaceChildren(...shown.map(b=>{const tr=node('tr');const guest=node('td',b.guest_name||'Name not supplied');guest.append(node('small',b.source_kind==='manual_direct'?`Historical direct · ${b.manual_reference}`:`Beds24 #${b.beds24_booking_id}`));
 const stay=node('td',`${b.arrival} → ${b.departure}`);stay.append(node('small',b.group.replaceAll('_',' ')));
 const operation=node('td',b.operational_status.replaceAll('_',' '));operation.append(node('small',b.operational_is_manual?'Staff reviewed':'From source; not a staff override'));
 const payment=node('td',!b.payment_visible?'Finance access required':b.payment_status?.replaceAll('_',' ')||'Not reviewed');
 if(b.payment_reviewed_at)payment.append(node('small',localTime(b.payment_reviewed_at)));
 const actions=node('td');if(data.staff.permissions.includes('operations.write'))actions.append(reviewForm(b,'operational'));
 if(data.staff.permissions.includes('finance.write'))actions.append(reviewForm(b,'payment'));
 tr.append(guest,node('td',data.properties.find(p=>p.slug===b.property_slug)?.name||b.property_slug),stay,
 node('td',`${b.adults??'?'} adults / ${b.children??'?'} children`),node('td',b.source_channel||'Not supplied'),node('td',b.source_status),operation,payment,node('td',b.attention.join(' · ')||'—','flags'),actions);return tr;}));
 el('empty').hidden=shown.length>0;
 renderCommunications();
}
async function load(){const current=epoch;try{const result=await api();if(current!==epoch)return;data=result;globalThis.currentOperationsStaff=[data.staff,data.properties];globalThis.loadStayReadiness?.(data.staff,data.properties);globalThis.initStayFinances?.(data.staff);el('identity').textContent=`${data.staff.display_name} · ${data.staff.role} · South African dates`;el('dashboard').hidden=false;
 warn(refreshFailed?'Latest refresh failed. Saved data may be stale; retry when the source is available.':data.diagnostics.warning||'Saved source data loaded. No guest communications are enabled.');render();
 }catch(error){el('dashboard').hidden=true;warn(`Dashboard unavailable: ${error.message}. Sign in again if your session expired.`);throw error;}}
el('group').addEventListener('change',render);
el('communications-booking').addEventListener('change',renderCommunications);
el('communications-enroll').addEventListener('click',async()=>{if(busy||!data?.communication_previews?.length)return;const booking_id=el('communications-booking').value;if(!booking_id)return;busy=true;renderCommunications();warn('Enrolling preview queue. Live sending remains disabled.');try{await api({action:'enroll_communications',booking_id});await load();warn('Preview queue enrolled and stored. Live sending is still disabled.');}catch(error){warn(error.message);}finally{busy=false;render();}});
el('refresh').addEventListener('click',async()=>{if(busy)return;busy=true;render();warn('Reading Beds24. The previous snapshot stays in place until the entire refresh succeeds.');
 try{await api({action:'sync'});refreshFailed=false;await load();}catch(error){refreshFailed=true;try{await load();}catch{}warn(error.message+' Saved data must be treated as potentially stale.');}
 finally{busy=false;render();}});
el('logout').addEventListener('click',async()=>{++epoch;el('dashboard').hidden=true;data=null;
 try{const r=await fetch('/api/staff-session',{method:'DELETE'});if(!r.ok)throw new Error();location.assign('/staff-login.html');}
 catch{warn('Sign-out could not be confirmed. Contact an administrator if it continues to fail.');}});
load().catch(()=>{});
// Surface age while the page remains open; this timer performs no network work.
setInterval(()=>{if(data?.diagnostics.last_success&&Date.now()-new Date(data.diagnostics.last_success.completed_at)>30*60*1000)warn('Data is now stale. Refresh from Beds24 before relying on it.');},60_000);
