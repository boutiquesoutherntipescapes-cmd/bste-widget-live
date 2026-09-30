// A missing historical amount is not an assertion that zero was paid.
function openingPaidValue(opening,party){
 if(!opening||opening[party+'_settlement_state']==='outstanding')return 0;
 const amount=opening[party+'_settled_cents'];
 if(opening[party+'_settled_amount_known']===false||(opening[party+'_settled_amount_known']==null&&!amount))return '';
 return amount/100;
}
function openingPaidInput(party,value){
 if(String(value??'').trim()==='')return {};
 const amount=Number(value);if(!Number.isFinite(amount)||amount<0||amount>10000000)throw Error('Invalid prior paid amount');
 return {[party+'_settled_cents']:Math.round(amount*100)};
}
// Same-origin staff API only. No Supabase keys or provider access in this browser file.
(()=>{
 const $=id=>document.getElementById(id);let staff,started=false,busy=false,selected;
 const text=(tag,value)=>{const e=document.createElement(tag);e.textContent=value;return e;};
 const money=n=>n==null?'Unknown':new Intl.NumberFormat('en-ZA',{style:'currency',currency:'ZAR'}).format(n/100);
 const say=message=>{$('finance-notice').textContent=message;};
 const pendingRequests=new Map();
 async function call(action,input={}){
  let fingerprint;
  if(input.request_key){const {request_key,...content}=input;fingerprint=action+JSON.stringify(content);
   if(!pendingRequests.has(fingerprint))pendingRequests.set(fingerprint,request_key);input={...input,request_key:pendingRequests.get(fingerprint)};}
  const r=await fetch('/api/staff-finances',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,input})});let d;try{d=await r.json();}catch{throw new Error('Server response could not be read. Save outcome is unconfirmed; inspect the booking before retrying.');}if(!r.ok)throw new Error(d.error||'Save rejected by server');return d;}
 function button(label,fn){const b=text('button',label);b.type='button';b.addEventListener('click',()=>run(fn));return b;}
 async function run(fn){if(busy)return;busy=true;try{await fn();}catch(e){say(e.message);}finally{busy=false;}}
 function form(title,fields,submit){const box=document.createElement('details');box.append(text('summary',title));const f=document.createElement('form'),inputs={};
  for(const [key,label,type,value,options] of fields){const l=text('label',label+' ');const i=document.createElement(options?'select':'input');
   if(options)for(const o of options){const opt=text('option',o.label??o);opt.value=o.value??o;i.append(opt);}
   else {i.type=type||'text';if(type==='number'){i.min='0';i.step='0.01';}i.maxLength=2000;}
   i.value=value??'';i.required=!label.includes('(optional)');inputs[key]=i;l.append(i);f.append(l,document.createElement('br'));}
  const feedback=text('p','');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
  const b=text('button','Save');b.type='submit';f.append(b,feedback);
  f.addEventListener('invalid',e=>{feedback.textContent='Please check '+(e.target.validationMessage||'the highlighted required field')+'.';},true);
  let saving=false;
  f.addEventListener('submit',async e=>{e.preventDefault();if(saving)return;if(busy){feedback.textContent='Another action is running. Please wait before saving.';return;}
   saving=true;busy=true;b.disabled=true;b.textContent='Saving...';feedback.textContent='Saving...';
   try{await submit(Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])));feedback.textContent='Saved successfully';}
   catch(error){feedback.textContent=error.message||'Save failed. Your entered values have been kept.';say(feedback.textContent);}
   finally{saving=false;busy=false;b.disabled=false;b.textContent='Save';}
  });box.append(f);return box;

 }
 const cents=v=>{if(!/^\d+(\.\d{1,2})?$/.test(String(v)))throw new Error('Use a positive rand amount with at most two decimals');return Math.round(Number(v)*100);};
 const field=(key,label,value,type='text',options)=>[key,label,type,value,options];
 const req=()=>crypto.randomUUID();
 async function load(){const d=await call('list',{month:$('finance-month').value});const area=$('finance-stays');area.replaceChildren();
  for(const b of d.bookings)area.append(button(`${b.guest_name||'Guest'} · ${b.source_kind==='manual_direct'?b.manual_reference:'#'+b.beds24_booking_id} · ${b.property_slug} · checkout ${b.departure}`,()=>detail(b.id)));
  if(!d.bookings.length)area.append(text('p','No stored stays in this checkout month. Historical stays not previously imported are not fetched automatically.'));
  const rates=$('finance-rates');rates.replaceChildren();const current=d.rates.filter(r=>!d.rates.some(n=>n.supersedes_id===r.id));
  rates.append(text('h3','Configured owner rates (end date exclusive)'));
  for(const r of current){rates.append(text('p',`${r.property_slug} · ${r.season} · ${r.starts_on} to ${r.ends_on} · ${money(r.rate_cents)} / night`));if(staff.permissions.includes('finance.configure'))rates.append(rateForm(r));}
  if(staff.permissions.includes('finance.configure'))rates.append(rateForm());say('Saved financial records loaded. Calculations remain Draft.');
 }
 function rateForm(r={}){return form(r.id?'Correct this rate period':'Add owner rate period',[
  field('property_slug','Property',r.property_slug||'legacy-suiderstrand','text',['legacy-suiderstrand','kalay-ridge-villa-struisbaai','the-pearl-beach-villa-agulhas']),
  field('season','Season',r.season||'low','text',['low','shoulder','high']),field('starts_on','First night',r.starts_on,'date'),field('ends_on','End date (excluded)',r.ends_on,'date'),
  field('rate','Owner nightly rate (R)',r.rate_cents?r.rate_cents/100:'' ,'number'),field('reason','Reason / agreement reference','')],async v=>{
   await call('rate',{...v,rate_cents:cents(v.rate),previous_id:r.id||null,request_key:req()});await load();
  });}
 async function detail(id,verified=null){selected=id;const d=verified||await call('detail',{booking_id:id}),area=$('finance-detail');area.replaceChildren();
  area.append(text('h3',`Draft finances · ${d.booking.source_kind==='manual_direct'?d.booking.manual_reference:'#'+d.booking.beds24_booking_id} · ${d.booking.property_slug}`));
  area.append(text('p',d.booking.source_kind==='manual_direct'?'Historical direct booking — manually recorded; no Beds24 reservation or source payment facts.':`Raw Beds24: ${d.booking.source_status}. Source booking value: ${d.source?.source_price??'Unknown'} ${d.source?.source_currency??'currency unconfirmed'}. This is not proof of funds received.`));
  area.append(text('p',`Eligibility: ${d.draft.eligibility} · Funds: ${d.draft.funds_status||'not reviewed'} · Checkout month: ${d.draft.checkout_month||d.booking.departure.slice(0,7)}`));
  area.append(text('p',`Opening-period: ${d.draft.opening_period?'yes':'not recorded'} · Owner: ${d.draft.owner_settlement_state} · Cleaner: ${d.draft.cleaner_settlement_state} · Monthly reconciliation: ${d.draft.monthly_reconciliation_eligible?'included':'not eligible'}`));
  if(d.draft.missing?.length)area.append(text('p',d.draft.missing.join(' · ')));
  for(const [k,v] of Object.entries(d.draft))if(k.endsWith('_cents'))area.append(text('p',`${k.replace(/_cents$/,'').replaceAll('_',' ')}: ${money(v)}`));
  const r=d.reviews[0];if(r)area.append(text('p','Owner nights: '+r.rate_nights.map(n=>`${n.night} ${n.season} ${money(n.rate_cents)}`).join('; ')));
  area.append(reviewForm(d));
  area.append(text('h4','Stay expenses — stocking and laundry normally owner-borne; unusual allocations must be explicit'));
  const current=d.expenses.filter(e=>!d.expenses.some(n=>n.previous_id===e.id));
  for(const e of current){const row=document.createElement('article');row.append(text('p',`${e.category}: ${money(e.amount_cents)} · ${e.supplier||'supplier missing'} · ${e.status}${e.is_void?' · VOID':''} · payer ${e.payer} · ${e.allocation}`));
   row.append(expenseForm(d.booking.id,e));
   row.append(uploadForm(e));area.append(row);
  }
  area.append(expenseForm(id));
  for(const a of d.attachments)area.append(button(`Download receipt: ${a.original_name}`,async()=>{const f=await call('download',{id:a.id});
   const bytes=Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:f.media_type}));const link=document.createElement('a');link.href=url;link.download=f.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}));
  if(staff.permissions.includes('finance.cutover'))area.append(form('Opening position — explicit Bond confirmation required',[
   field('opening_period','Opening-period / pre-system stay',(d.openings[0]?.opening_period??(d.booking.departure<='2026-09-23'))?'yes':'no','text',['yes','no']),
   field('owner_state','Owner obligation',d.openings[0]?.owner_settlement_state||'outstanding','text',['outstanding','partially_settled','fully_settled']),
   field('cleaner_state','Cleaner obligation',d.openings[0]?.cleaner_settlement_state||'outstanding','text',['outstanding','partially_settled','fully_settled']),
   field('owner_paid','Previously paid to owner (R) (optional) — blank if unknown',openingPaidValue(d.openings[0],'owner'),'number'),
   field('cleaner_paid','Previously paid to cleaner (R) (optional) — blank if unknown',openingPaidValue(d.openings[0],'cleaner'),'number'),
   field('confirmed','Bond confirms any recorded prior owner/cleaner payments (not channel receipts)','no','text',['no','yes']),field('reason','Evidence / reason','')],async v=>{
    await call('opening',{booking_id:id,previous_id:d.openings[0]?.id||null,request_key:req(),opening_period:v.opening_period==='yes',
     state:v.owner_state==='fully_settled'&&v.cleaner_state==='fully_settled'?'fully_settled_historical':'open',
     owner_settlement_state:v.owner_state,cleaner_settlement_state:v.cleaner_state,...openingPaidInput('owner',v.owner_paid),...openingPaidInput('cleaner',v.cleaner_paid),
     confirmed_by_bond:v.confirmed==='yes',reason:v.reason});await detail(id);
   }));
  const history=document.createElement('details');history.append(text('summary','Finance-only history'));
  for(const e of d.history)history.append(text('p',`${e.occurred_at} · ${e.actor_name} (${e.actor_role}) · ${e.entity_table} · ${e.action} · ${e.detail?.after?.reason||e.detail?.after?.change_reason||''}`));
  for(const v of d.reviews)history.append(text('p',`Finance revision ${v.id}: ${v.status} · accommodation ${money(v.accommodation_cents)} · funds ${money(v.funds_received_cents)} · ${v.created_at}`));
  area.append(history);say('Draft stay finances loaded. No owner or cleaner payment will be initiated.');
 }
 function ownerNightEditor(nights){
  const section=document.createElement('section');section.append(text('h4','Owner payout for this stay'),text('p','Standard rate = property default. Agreed rate = what the owner earns for that occupied night. This records entitlement, not payment.'));
  const table=document.createElement('table'),head=document.createElement('tr');for(const label of ['Date','Season','Standard rate','Agreed rate (R)'])head.append(text('th',label));table.append(head);
  const inputs=nights.map(n=>{const row=document.createElement('tr'),cell=document.createElement('td'),input=document.createElement('input');input.type='number';input.min='0';input.max='1000000';input.step='0.01';input.value=n.rate_cents==null?'':n.rate_cents/100;input.setAttribute('aria-label','Agreed owner rate for '+n.night);cell.append(input);row.append(text('td',n.night),text('td',n.season||'Not configured'),text('td',money(n.default_rate_cents)),cell);table.append(row);return input;});
  section.append(table);const all=document.createElement('input');all.type='number';all.min='0';all.step='0.01';const label=text('label','Apply owner rate R ');label.append(all);section.append(label,button('Apply to all nights',()=>{const amount=cents(all.value);if(amount>100000000)throw Error('Rate exceeds limit');inputs.forEach(i=>{i.value=amount/100;});}));
  const reason=document.createElement('input'),reasonLabel=text('label','Reason for rate adjustment: ');reason.maxLength=2000;reasonLabel.append(reason);section.append(reasonLabel);
  if(!nights.length||nights.some(n=>!n.rate_id))section.append(text('p','Configure standard owner rates for every occupied night before saving.'));
  return {section,values(){if(!nights.length||nights.some(n=>!n.rate_id))throw Error('Configure standard owner rates for every occupied night');const owner_nights=nights.map((n,i)=>{const rate=cents(inputs[i].value);if(rate>100000000)throw Error('Rate exceeds limit');if(rate!==n.default_rate_cents&&!reason.value.trim()&&!(n.is_override&&rate===n.rate_cents&&n.adjustment_reason))throw Error('Reason required for agreed rate adjustment');return {night:n.night,rate_id:n.rate_id,default_rate_cents:n.default_rate_cents,rate_cents:rate};});return {owner_nights,owner_rate_reason:reason.value.trim()};}};
 }
 function reviewForm(d){const r=d.reviews[0]||{};const nightly=ownerNightEditor(d.owner_nights||[]);const box=form('Enter / revise financial review',[
  field('accommodation','Accommodation revenue only (R)',r.accommodation_cents==null?'':r.accommodation_cents/100,'number'),
  field('cleaning','Guest cleaning charge (R)',(r.cleaning_charge_cents??100000)/100,'number'),field('fees','Channel/platform fees (R)',r.channel_fees_cents==null?'':r.channel_fees_cents/100,'number'),
  field('cleaner','Cleaner cost (R)',(r.cleaner_cost_cents??80000)/100,'number'),field('cleaner_supplier','Cleaner / supplier',r.cleaner_supplier),
  field('received','Cumulative actual BSTE funds received for this stay (R)',(r.funds_received_cents??0)/100,'number'),field('funds_as_of','Funds evidence date',new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Johannesburg'}),'date'),
  field('expenses_complete','All stay expenses captured and reconciliation complete',r.expenses_complete?'yes':'no','text',['no','yes']),
  field('funds_evidence','Funds evidence (optional only when zero)',r.funds_evidence),field('status','Financial review', 'draft','text',staff.permissions.includes('finance.review')?['draft','reviewed']:['draft']),field('reason','Review / correction reason','')],async v=>{
   const saved=await call('review',{booking_id:d.booking.id,previous_id:r.id||null,request_key:req(),accommodation_cents:cents(v.accommodation),cleaning_charge_cents:cents(v.cleaning),
    channel_fees_cents:cents(v.fees),cleaner_cost_cents:cents(v.cleaner),cleaner_supplier:v.cleaner_supplier,funds_received_cents:cents(v.received),funds_as_of:v.funds_as_of,
    expenses_complete:v.expenses_complete==='yes',funds_evidence:v.funds_evidence,reason:v.reason,status:v.status,...nightly.values()});
   if(saved.saved!==true||typeof saved.id!=='string')throw Error('Save outcome unconfirmed. Inspect the booking before retrying.');
   let verified;try{verified=await call('detail',{booking_id:d.booking.id});}catch{throw Error('Save may have succeeded, but verification failed. Your values are retained. Inspect the booking before retrying.');}
   if(!verified.reviews?.some(review=>review.id===saved.id&&review.booking_id===d.booking.id))throw Error('Saved review was not found during verification. Your values are retained. Inspect the booking before retrying.');
   await detail(d.booking.id,verified);
   const confirmation=text('p','Saved successfully — financial review verified.');confirmation.setAttribute('role','status');$('finance-detail').append(confirmation);
  });box.insertBefore(nightly.section,box.children[1]);return box;}
 function expenseForm(booking,e={}){return form(e.id?'Correct / approve / void expense (keeps original)':'Add expense',[
  field('incurred_on','Expense date',e.incurred_on,'date'),field('category','Category',e.category||'stocking','text',['stocking','laundry','maintenance','consumables','welcome_items','repairs','contractor','miscellaneous']),
  field('supplier','Supplier',e.supplier),field('supplier_reference','Reference (optional)',e.supplier_reference),field('description','Description',e.description),
  field('amount','Total (R)',e.amount_cents?e.amount_cents/100:'','number'),field('payer','Paid by',e.payer||'bste','text',['bste','owner','guest','unpaid']),
  field('allocation','Allocation',e.allocation||'needs_review','text',['owner','bste','guest','split','needs_review']),
  field('owner','Split: owner amount (R)',(e.owner_amount_cents??0)/100,'number'),field('guest','Split: guest amount (R)',(e.guest_amount_cents??0)/100,'number'),
  field('bste','Split: BSTE amount (R)',(e.bste_amount_cents??0)/100,'number'),field('no_receipt_reason','No receipt reason (optional)',e.no_receipt_reason),
  field('status','Expense status','draft','text',staff.permissions.includes('expenses.approve')?['draft','review','approved']:['draft','review']),
  field('is_void','Void this expense', 'no','text',['no','yes']),field('reason','Entry / correction reason','')],async v=>{
   const amount=cents(v.amount);let owner=0,guest=0,bste=0;
   if(v.allocation==='owner')owner=amount;else if(v.allocation==='guest')guest=amount;else if(v.allocation==='bste')bste=amount;
   else if(v.allocation==='split'){owner=cents(v.owner);guest=cents(v.guest);bste=cents(v.bste);if(owner+guest+bste!==amount)throw new Error('Split amounts must equal the total');}
   await call('expense',{booking_id:booking,previous_id:e.id||null,request_key:req(),incurred_on:v.incurred_on,category:v.category,supplier:v.supplier,
    supplier_reference:v.supplier_reference,description:v.description,amount_cents:amount,payer:v.payer,allocation:v.allocation,owner_amount_cents:owner,
    guest_amount_cents:guest,bste_amount_cents:bste,no_receipt_reason:v.no_receipt_reason,status:v.status,is_void:v.is_void==='yes',reason:v.reason});await detail(booking);
  });}
 function uploadForm(e){const f=document.createElement('form');const input=document.createElement('input');input.type='file';input.accept='.jpg,.jpeg,.png,.pdf';input.required=true;
  const b=text('button','Attach private receipt (optional, up to 2 MiB)');b.type='submit';f.append(input,b);let key=req();
  input.addEventListener('change',()=>{key=req();});
  f.addEventListener('submit',event=>{event.preventDefault();run(async()=>{const file=input.files[0];if(!file||file.size>2097152)throw new Error('Select a receipt up to 2 MiB');
   const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
   await call('upload',{expense_id:e.id,request_key:key,original_name:file.name,media_type:file.type,base64:btoa(binary)});key=req();await detail(selected);
  });});return f;
 }
 globalThis.initStayFinances=s=>{staff=s;$('stay-finances').hidden=!s.permissions.includes('finance.read');if(started)return;started=true;
  $('finance-month').value=new Date(Date.now()+7200000).toISOString().slice(0,7);$('finance-load').addEventListener('click',()=>run(load));
 };
})();
