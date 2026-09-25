import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const sql=read('supabase/migrations/202609240003_align_opening_write_path.sql');
test('new opening writer preserves other action branches exactly',()=>{
 const original=read('supabase/migrations/202609230001_stay_finances.sql');
 const review=s=>s.split(" elsif action_name='review' then")[1].split('end $$;')[0];
 assert.equal(review(sql),review(original));
 assert.match(sql,/create or replace function public.ops_finance_write/);
 assert.match(sql,/grant execute on function public.ops_finance_write\(text,jsonb\) to authenticated/);
 assert.match(sql,/Request key already used with different content or actor/);
 assert.match(sql,/Stale financial revision/);
});
test('opening path explicitly validates states and amounts without payment writes',()=>{
 const branch=sql.split("  opening_state:=input->>'state';")[1].split(" elsif action_name='review'")[0];
 for(const field of ['opening_period','owner_settlement_state','cleaner_settlement_state','owner_settled_cents','cleaner_settled_cents','owner_settled_amount_known','cleaner_settled_amount_known'])assert.ok(branch.includes(field));
 for(const error of ['contradicts obligation states','Partial settlement requires','Outstanding obligation cannot','Bond confirmation required','non-negative integer cents'])assert.ok(branch.includes(error));
 assert.deepEqual([...branch.matchAll(/insert into public\.(\w+)/g)].map(m=>m[1]),['ops_stay_opening_positions']);
 assert.ok(sql.indexOf("if action_name='opening' and")<sql.indexOf('if result is not null then return result'));
});
test('finance UI preserves unknown paid amounts rather than manufacturing zero',()=>{
 const ui=read('public/staff-finances.js');const context=vm.createContext({});vm.runInContext(ui.split('// Same-origin staff API only.')[0],context);
 assert.equal(context.openingPaidValue({owner_settlement_state:'fully_settled',owner_settled_cents:0,owner_settled_amount_known:false},'owner'),'');
 assert.equal(JSON.stringify(context.openingPaidInput('owner','')),'{}');
 assert.equal(context.openingPaidInput('owner','0').owner_settled_cents,0);
 assert.throws(()=>context.openingPaidInput('owner','bad'));
 assert.ok(ui.includes('(optional) — blank if unknown'));
});
