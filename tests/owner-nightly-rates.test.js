import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {draftStay} from '../lib/stay-finances.js';
const sql=fs.readFileSync(new URL('../supabase/migrations/202609250001_add_owner_shoulder_and_booking_rate_overrides.sql',import.meta.url),'utf8');
const old=fs.readFileSync(new URL('../supabase/migrations/202609240003_align_opening_write_path.sql',import.meta.url),'utf8');
test('new migration accepts all three seasons and preserves non-review write branches',()=>{
 assert.match(sql,/season in \('low','shoulder','high'\)/);
 for(const [start,end] of [[" if action_name='rate' then"," elsif action_name='review' then"],["  select jsonb_build_object('booking'","end \$\$;"]])assert.equal(sql.slice(sql.indexOf(start),sql.indexOf(end,sql.indexOf(start))),old.slice(old.indexOf(start),old.indexOf(end,old.indexOf(start))));
});
test('SQL guards coverage, duplicates, cents, reason, stale defaults and immutable agreement carry-forward',()=>{
 for(const value of ['every occupied night exactly once','Standard rates changed','Reason required','non-negative integer cents','previous_rate_cents','is_override','adjustment_reason',"ops_can('finance.read')",'revoke all','finance-request:','Stale financial revision'])assert.ok(sql.includes(value),value);
 assert.match(sql,/case when \(old.n->>'is_override'\)::boolean is true/);
 assert.doesNotMatch(sql,/insert into public\.ops_payment_records|update public\.ops_owner_rate_periods/);
});
function editor(nights){const el=tag=>({tag,children:[],value:'',handlers:{},append(...c){this.children.push(...c);},addEventListener(k,v){this.handlers[k]=v;},setAttribute(){}});const ctx=vm.createContext({document:{createElement:el,getElementById:()=>el('div')},Intl,Date});let js=fs.readFileSync(new URL('../public/staff-finances.js',import.meta.url),'utf8');js=js.replace(' globalThis.initStayFinances=', ' globalThis.testOwnerNightEditor=ownerNightEditor; globalThis.initStayFinances=');vm.runInContext(js,ctx);const x=ctx.testOwnerNightEditor(nights);const flat=n=>[n,...n.children.flatMap(flat)];const nodes=flat(x.section);return {x,inputs:nodes.filter(n=>n.tag==='input'),nodes};}
const nights=[{night:'2026-09-05',season:'low',rate_id:'one',default_rate_cents:500000,rate_cents:500000},{night:'2026-09-06',season:'shoulder',rate_id:'two',default_rate_cents:650000,rate_cents:650000},{night:'2026-09-07',season:'high',rate_id:'three',default_rate_cents:800000,rate_cents:800000}];
test('UI shows standard/agreed rates, defaults and both season crossings',()=>{const e=editor(nights);assert.deepEqual(Array.from(e.x.values().owner_nights,n=>n.rate_cents),[500000,650000,800000]);const text=e.nodes.map(n=>n.textContent).join(' ');for(const label of ['Owner payout for this stay','Standard rate','Agreed rate','low','shoulder','high'])assert.ok(text.includes(label));});
test('one-night and mixed agreements require reason and leave defaults untouched',()=>{const original=JSON.stringify(nights),e=editor(nights);e.inputs[1].value='7000';assert.throws(()=>e.x.values(),/Reason required/);e.inputs[4].value='Owner agreed';assert.equal(e.x.values().owner_nights[1].rate_cents,700000);e.inputs[0].value='5100';assert.deepEqual(Array.from(e.x.values().owner_nights,n=>n.rate_cents),[510000,700000,800000]);assert.equal(JSON.stringify(nights),original);});
test('apply to all populates occupied nights; historical dates are editable',async()=>{const e=editor(nights);e.inputs[3].value='7000';e.inputs[4].value='Historical agreement';await e.nodes.find(n=>n.textContent==='Apply to all nights').handlers.click();assert.deepEqual(Array.from(e.x.values().owner_nights,n=>n.rate_cents),[700000,700000,700000]);});
test('existing agreed override survives a different current default without losing its reason',()=>{const e=editor([{...nights[1],rate_cents:700000,default_rate_cents:675000,is_override:true,adjustment_reason:'Previous agreement'}]);assert.equal(e.x.values().owner_nights[0].rate_cents,700000);});
test('owner gross sums actual nightly values; does not mark funds or settlement',()=>{const f={rate_nights:[{rate_cents:500000},{rate_cents:700000},{rate_cents:800000}],accommodation_cents:2500000,cleaning_charge_cents:100000,channel_fees_cents:0,cleaner_cost_cents:80000,funds_received_cents:0,status:'draft'};const d=draftStay(f,[],null,{departure:'2026-09-08'},'2026-09-25');assert.equal(d.owner_gross_cents,2000000);assert.equal(d.received_cents,0);assert.equal(d.owner_settlement_state,'outstanding');});
test('rollback SQL exercises real writer, historical revision, idempotency and absence of cash writes',()=>{const s=fs.readFileSync(new URL('./owner-nightly-rates-rls.sql',import.meta.url),'utf8');for(const text of ['ops_finance_write','ops_session_valid','Idempotency failed','Override changed property default','Revision history missing','Payment created','Settlement created','rollback;'])assert.ok(s.includes(text));});

test('financial review sends final per-night entries and reason to the audited review action',()=>{
 const ui=fs.readFileSync(new URL('../public/staff-finances.js',import.meta.url),'utf8');
 assert.match(ui,/status:v.status,\.\.\.nightly.values\(\)/);
 assert.match(ui,/box.insertBefore\(nightly.section,box.children\[1\]\)/);
 const api=fs.readFileSync(new URL('../api/staff-finances.js',import.meta.url),'utf8');
 assert.match(api,/request\('rpc\/ops_owner_nights',token/);
 assert.match(api,/history,draft,owner_nights/);
});
