import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const sql=read('supabase/migrations/202609250002_fix_financial_review_expenses_complete_schema.sql');
test('canonical flag is boolean NOT NULL default false and additive correction preserves it',()=>{
 const old=read('supabase/migrations/202609230001_stay_finances.sql');assert.match(old,/expenses_complete boolean not null default false/);
 assert.match(sql,/add column if not exists expenses_complete boolean not null default false/);
 assert.match(sql,/a.atttypid='boolean'::regtype and a.attnotnull/);assert.match(sql,/pg_get_expr\(d.adbin,d.adrelid\)='false'/);
});
test('migration guards all canonical review columns and only tolerates the confirmed absence',()=>{
 const block=read('supabase/migrations/202609230001_stay_finances.sql').split('create table public.ops_stay_financial_reviews (')[1].split(');')[0];
 const cols=[...block.matchAll(/\b([a-z_]+) (uuid|text|bigint|date|boolean|jsonb|timestamptz)\b/g)].map(m=>m[1]);assert.equal(cols.length,21);
 for(const col of cols)assert.ok(sql.includes("('"+col+"',"),col);
 assert.ok(sql.includes("not(column_name='expenses_complete' and result='missing')"));
 for(const value of ['type_mismatch','nullability_mismatch','default_mismatch','unexpected_column','access exclusive mode','relrowsecurity'])assert.ok(sql.includes(value));
});
test('migration has no finance DML, function changes or security weakening',()=>{
 const executable=sql.replace(/--[^\n]*/g,'').replace(/'(?:''|[^'])*'/g,'');
 assert.doesNotMatch(executable,/\b(update|delete|insert|drop|grant|revoke)\b/i);
 assert.doesNotMatch(sql,/create (?:or replace )?function|disable row level|ops_finance_write|ops_stay_opening_positions/);
 assert.match(sql,/commit;\s*$/);
});
test('real rollback asserts canonical schema, exact unpaid review values and no residual rows',()=>{
 const s=read('tests/finance-review-real-legacy-rollback.sql');
 for(const token of ["a.attname='expenses_complete'","a.atttypid='boolean'::regtype",'a.attnotnull',"pg_get_expr(d.adbin,d.adrelid)='false'",'not f.expenses_complete','2800000','5148000','4326924','before_state is distinct from after_state','after_reviews<>0','fixtures_gone'])assert.ok(s.includes(token),token);
});

test('rollback upgrade fixture embeds exact migration logic and preserves a pre-existing review',()=>{
 const fixture=read('tests/financial-review-schema-upgrade.sql');
 const body=sql.slice(sql.indexOf('set local lock_timeout'),sql.lastIndexOf('commit;')).replaceAll('public.ops_stay_financial_reviews','pg_temp.review_schema_fixture');
 assert.ok(fixture.includes(body));assert.equal((fixture.match(/select pg_temp.apply_review_schema_fixture\(\);/g)||[]).length,2);
 assert.ok(fixture.includes("to_jsonb(f)-'expenses_complete'=s.original"));assert.ok(fixture.includes('Incompatible default was not rejected'));
 assert.doesNotMatch(fixture,/references public\./);assert.match(fixture,/rollback;\s*$/);
});
