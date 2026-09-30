import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const sql=fs.readFileSync(new URL('./finance-review-real-legacy-rollback.sql',import.meta.url),'utf8');
test('real booking rollback diagnostic binds exact identity and refuses existing reviews',()=>{
 for(const s of ['beds24_booking_id=92622943',"property_slug='legacy-suiderstrand'",'beds24_property_id=351452','beds24_room_id=724919','2026-09-05','2026-09-13','before_reviews<>0','matches<>1'])assert.ok(sql.includes(s));
 assert.doesNotMatch(sql,/insert into public.ops_bookings|ops_finance_write\('rate'/i);
});
test('exact browser payload uses real review RPC with production auth checks',()=>{
 for(const s of ['5148000','117500','938576','80000','4326924','350000','2800000',"'owner_rate_reason',''","'cleaner_supplier','Felicia'",'public.ops_session_valid()',"public.ops_can('finance.write')","saved:=public.ops_finance_write('review',payload)"])assert.ok(sql.includes(s));
});
test('success and failure roll back before counts and full-row hashes are asserted',()=>{
 for(const s of ["errcode='ZX001'",'get stacked diagnostics','pg_exception_context','before_state is distinct from after_state','after_reviews<>0','fixtures_gone','new_finance_requests','opening_positions_unchanged','rollback_verified'])assert.ok(sql.includes(s));
 assert.ok(sql.indexOf('after_state:=')>sql.indexOf('get stacked diagnostics'));
 assert.match(sql,/rollback;\s*$/);assert.doesNotMatch(sql,/commit;|raise notice/i);
});
