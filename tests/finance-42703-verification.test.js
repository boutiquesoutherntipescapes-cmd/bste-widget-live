import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const migration=read('supabase/migrations/202609250001_add_owner_shoulder_and_booking_rate_overrides.sql');
const diagnostic=read('docs/finance-42703-verification.sql');
test('42703 diagnostic checks both exact function bodies without executing application functions',()=>{
 for(const start of ['create function public.ops_owner_nights','create or replace function public.ops_finance_write']){const body=migration.split(start)[1].split('as $$')[1].split('$$;')[0];assert.ok(diagnostic.includes(createHash('md5').update(body).digest('hex')));}
 assert.match(diagnostic,/pg_get_function_result/);assert.match(diagnostic,/missing_referenced_columns/);assert.match(diagnostic,/n_field_exists/);
 assert.doesNotMatch(diagnostic.replace(/'(?:''|[^'])*'/g,''),/\b(insert|update|delete|alter|create|call)\s+(?:into|table|function|public\.)/i);
});
test('all nightly and review SQL table columns exist in local schema declarations',()=>{
 const schema=read('supabase/migrations/202609230001_stay_finances.sql');
 const rates=schema.split('create table public.ops_owner_rate_periods (')[1].split(');')[0];
 for(const c of ['id','property_slug','starts_on','ends_on','supersedes_id','season','rate_cents'])assert.match(rates,new RegExp('\\b'+c+'\\s'));
 const reviews=schema.split('create table public.ops_stay_financial_reviews (')[1].split(');')[0];
 const cols=migration.split('insert into public.ops_stay_financial_reviews(')[1].split(')')[0].split(',').map(x=>x.trim());
 for(const c of [...cols,'id','created_at'])assert.match(reviews,new RegExp('\\b'+c+'\\s'));
 assert.match(migration,/night_row jsonb; submitted jsonb/);assert.match(migration,/left join lateral \(select n from jsonb_array_elements/);
});
test('exact September SQL exercises real helper and RPC, asserts stored cents and rolls back',()=>{
 const sql=read('tests/finance-review-exact-september-rls.sql');
 for(const s of ['2026-09-05','2026-09-13','350000','5148000','117500','938576','80000','4326924','2800000',"'owner_rate_reason',''",'public.ops_session_valid()',"public.ops_finance_write('review'",'rollback;'])assert.ok(sql.includes(s),s);
 assert.doesNotMatch(sql,/92622943|exception when others/);assert.match(sql,/jsonb_array_length.*=8/);
});
