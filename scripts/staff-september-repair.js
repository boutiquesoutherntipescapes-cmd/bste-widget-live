const status=document.getElementById('status'),preview=document.getElementById('preview'),confirmed=document.getElementById('confirmed'),button=document.getElementById('repair');
let ready=false,attempted=false;
async function call(body){const r=await fetch('/local/september-repair',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'Request blocked');return data;}
confirmed.addEventListener('change',()=>{button.disabled=!ready||!confirmed.checked||attempted;});
button.addEventListener('click',async()=>{
 if(!ready||!confirmed.checked||attempted)return;
 attempted=true;button.disabled=true;confirmed.disabled=true;status.textContent='Verifying and repairing once…';
 try{const data=await call({action:'repair',confirmed:true});if(data.success!==true)throw Error('Unconfirmed result');preview.textContent=JSON.stringify(data,null,2);status.textContent='SUCCESS — 17 bookings / 1 batch / 1 result / 3 unpaid opening positions verified.';}
 catch{status.textContent='Outcome unconfirmed. Stop and inspect staging before doing anything else. Do not retry or restart the server. No automatic retry.';}
});
call({action:'preview'}).then(data=>{preview.textContent=JSON.stringify(data,null,2);ready=!data.complete;confirmed.disabled=!ready;status.textContent=data.complete?'Already repaired: all three unpaid opening positions verified. No execution needed.':'Read-only preview complete. Review all three stays before confirming.';}).catch(()=>{status.textContent='Preview blocked. Inspect staging/session before proceeding. No automatic retry.';});
