const button=document.getElementById('run-preview');
const status=document.getElementById('status');
const results=document.getElementById('results');
let attempted=false;
function line(text,tag='p'){const e=document.createElement(tag);e.textContent=text;results.append(e);}
function table(title,rows){
 line(title,'h2');if(!rows.length){line('None');return;}
 const table=document.createElement('table');const headings=['Masked booking ID','Property','Arrival','Departure','Nights','Raw status','Source/channel','Already stored','Opening-period eligible','Changed fields','Condition'];
 const header=document.createElement('tr');for(const h of headings){const th=document.createElement('th');th.textContent=h;header.append(th);}table.append(header);
 for(const r of rows){const tr=document.createElement('tr');for(const v of [r.booking_id,r.property,r.arrival,r.departure,r.nights,r.raw_status,r.channel,r.already_stored===null?'Unknown':r.already_stored?'Yes':'No',r.opening_period_eligible?'Yes — does not mean paid':'No',r.changed_fields.join(', ')||'None',r.condition||'']){const td=document.createElement('td');td.textContent=String(v??'Unknown');tr.append(td);}table.append(tr);}results.append(table);
}
button.addEventListener('click',async()=>{
 if(attempted)return;attempted=true;button.disabled=true;results.replaceChildren();status.textContent='Reading the preview once…';
 try {
  const response=await fetch('/local/september-preview',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:'{}'});
  if(!response.ok)throw new Error('Preview failed');
  const data=await response.json();
  line(`Total source records: ${data.total_records}; unique bookings: ${data.unique_records}`);
  for(const p of data.by_property)line(`${p.property}: ${p.count}`);
  line(`Already stored: ${data.already_stored}; missing validated records: ${data.missing_records}; missing guest candidates: ${data.missing_guest_candidates}; records requiring review: ${data.records_requiring_review}`);
  line(data.notice);table('Candidate guest stays',data.candidates);
  const names={cancelled:'Cancelled',requests_inquiries:'Requests / inquiries',blocks:'Blocks',non_guest:'Non-guest records',unusual_status:'Unusual / invalid records',conflicts_duplicates:'Conflicts / duplicates',stored_not_returned:'Stored but not returned'};
  for(const [key,title] of Object.entries(names))table(title,data.exceptional[key]);table('Differences from staging (field names only)',data.differences);
  status.textContent=`Preview complete. Import handoff ready: ${data.import_ready===true?'YES':'NO'}. ${data.import_ready===true?'':`${data.reason_code||'HANDOFF_UNAVAILABLE'}: ${data.reason||'Selection readiness could not be established.'} `}Zero application-data writes; normal sync unchanged. Nothing imported.`;
 } catch {status.textContent='Preview failed. No automatic retry. If the session expired, sign in again. Reload this page only when you deliberately want to authorize another attempt.';}
});
button.disabled=false;
