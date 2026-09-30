import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const foundation=read('supabase/migrations/202609180001_operations_foundation.sql');
const finance=read('supabase/migrations/202609230001_stay_finances.sql');
const diagnostic=read('docs/finance-review-trigger-verification.sql');
const body=n=>foundation.split('create function public.'+n+'()')[1].split('as $$')[1].split('$$;')[0];
test('review insert audits through generic JSON; immutability trigger is not an INSERT trigger',()=>{
 assert.match(finance,/create trigger audit_change after insert on public\.%I for each row execute function public\.ops_audit_change\(\)/);
 assert.match(finance,/create trigger immutable before update or delete/);
 const audit=body('ops_audit_change');assert.match(audit,/to_jsonb\(new\)/);assert.doesNotMatch(audit,/\b(?:new|old)\s*\./i);
 const columns=audit.split('insert into public.ops_events(')[1].split(')')[0].split(',').map(x=>x.trim());
 const events=foundation.split('create table public.ops_events (')[1].split(');')[0];
 for(const col of columns)assert.match(events,new RegExp(String.raw`\b${col}\s`));
});
test('trigger diagnostic is read-only, includes installed source and checks downstream fields',()=>{
 for(const name of ['ops_audit_change','ops_no_change'])assert.ok(diagnostic.includes(createHash('md5').update(body(name)).digest('hex')));
 for(const token of ['pg_get_triggerdef','pg_trigger','installed_function_body','direct_new_old_references','possibly_missing_direct_fields','missing_events_insert_columns','current_columns','fires_on_insert'])assert.ok(diagnostic.includes(token));
 const stripped=diagnostic.replace(/--[^\n]*/g,'').replace(/'(?:''|[^'])*'/g,'');
 assert.doesNotMatch(stripped,/\b(insert|update|delete|alter|create|call|do)\b/i);
 assert.doesNotMatch(stripped,/from\s+(?:public|auth)\./i);
});
