import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('compact diagnostic outputs requested flat columns and inspects INSERT audit only',()=>{
 const s=read('docs/finance-review-trigger-compact.sql');
 for(const name of ['trigger_name','trigger_definition','trigger_function_signature','trigger_function_hash','expected_local_hash','exact_local_match','direct_new_old_column_refs','missing_direct_column_refs','review_missing_required_columns','ops_events_missing_required_columns','ops_staff_missing_required_columns'])assert.ok(s.includes(' as '+name),name);
 assert.ok(s.includes("t.tgname='audit_change'"));assert.ok(s.includes('(t.tgtype::integer & 4)<>0'));
 assert.doesNotMatch(s,/jsonb_build_object|installed_function_body/);
});
test('context diagnostic uses same synthetic real-RPC regression and forces rollback on success and failure',()=>{
 const s=read('tests/finance-review-september-context-rollback.sql');
 for(const v of ['get stacked diagnostics','pg_exception_context',"errcode='ZX001'",'exception when others','rollback;',"public.ops_finance_write('review'",'5148000','117500','938576','80000','4326924','2800000'])assert.ok(s.includes(v),v);
 assert.doesNotMatch(s,/92622943|commit;|raise notice/i);
 const original=read('tests/finance-review-exact-september-rls.sql');let body=original.slice(original.indexOf('insert into auth.users'),original.lastIndexOf('rollback;')).replace('set local role authenticated;',"execute 'set local role authenticated';").replace('reset role;',"execute 'reset role';").split('\n').map(l=>l.startsWith('select ')?'perform '+l.slice(7):l).join('\n').trim();assert.ok(s.includes(body));
});
