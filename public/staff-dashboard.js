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
function render(){if(!data)return;
 el('properties').replaceChildren(...data.properties.map(p=>{const card=node('article',null,'card');card.append(node('strong',p.name),node('span',p.count,'count'),node('small','saved current / future records'));return card;}));
 const d=data.diagnostics,run=d.last_attempt;
 el('sync-state').textContent=`Last successful sync: ${localTime(d.last_success?.completed_at)} · Beds24 read: ${run?.source_read_status||'not run'} · Latest attempt: ${run?.status||'not run'}${run?.error_code?' ('+run.error_code+')':''}`;
 el('sync-counts').textContent=`Latest successful import: ${d.last_success?.imported_count??0} records. `+data.properties.map(p=>`${p.name}: ${d.last_success?.property_counts?.[p.slug]??0}`).join(' · ');
 el('refresh').disabled=busy||!data.staff.permissions.includes('sync.run');
 const shown=data.bookings.filter(b=>el('group').value==='all'||b.group===el('group').value);
 el('bookings').replaceChildren(...shown.map(b=>{const tr=node('tr');const guest=node('td',b.guest_name||'Name not supplied');guest.append(node('small',`Beds24 #${b.beds24_booking_id}`));
 const stay=node('td',`${b.arrival} → ${b.departure}`);stay.append(node('small',b.group.replaceAll('_',' ')));
 const operation=node('td',b.operational_status.replaceAll('_',' '));operation.append(node('small',b.operational_is_manual?'Staff reviewed':'From source; not a staff override'));
 const payment=node('td',!b.payment_visible?'Finance access required':b.payment_status?.replaceAll('_',' ')||'Not reviewed');
 if(b.payment_reviewed_at)payment.append(node('small',localTime(b.payment_reviewed_at)));
 const actions=node('td');if(data.staff.permissions.includes('operations.write'))actions.append(reviewForm(b,'operational'));
 if(data.staff.permissions.includes('finance.write'))actions.append(reviewForm(b,'payment'));
 tr.append(guest,node('td',data.properties.find(p=>p.slug===b.property_slug)?.name||b.property_slug),stay,
 node('td',`${b.adults??'?'} adults / ${b.children??'?'} children`),node('td',b.source_channel||'Not supplied'),node('td',b.source_status),operation,payment,node('td',b.attention.join(' · ')||'—','flags'),actions);return tr;}));
 el('empty').hidden=shown.length>0;
}
async function load(){const current=epoch;try{const result=await api();if(current!==epoch)return;data=result;globalThis.initStayFinances?.(data.staff);el('identity').textContent=`${data.staff.display_name} · ${data.staff.role} · South African dates`;el('dashboard').hidden=false;
 warn(refreshFailed?'Latest refresh failed. Saved data may be stale; retry when the source is available.':data.diagnostics.warning||'Saved source data loaded. No guest communications are enabled.');render();
 }catch(error){el('dashboard').hidden=true;warn(`Dashboard unavailable: ${error.message}. Sign in again if your session expired.`);throw error;}}
el('group').addEventListener('change',render);
el('refresh').addEventListener('click',async()=>{if(busy)return;busy=true;render();warn('Reading Beds24. The previous snapshot stays in place until the entire refresh succeeds.');
 try{await api({action:'sync'});refreshFailed=false;await load();}catch(error){refreshFailed=true;try{await load();}catch{}warn(error.message+' Saved data must be treated as potentially stale.');}
 finally{busy=false;render();}});
el('logout').addEventListener('click',async()=>{++epoch;el('dashboard').hidden=true;data=null;
 try{const r=await fetch('/api/staff-session',{method:'DELETE'});if(!r.ok)throw new Error();location.assign('/staff-login.html');}
 catch{warn('Sign-out could not be confirmed. Contact an administrator if it continues to fail.');}});
load().catch(()=>{});
// Surface age while the page remains open; this timer performs no network work.
setInterval(()=>{if(data?.diagnostics.last_success&&Date.now()-new Date(data.diagnostics.last_success.completed_at)>30*60*1000)warn('Data is now stale. Refresh from Beds24 before relying on it.');},60_000);
