import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const sql=read('supabase/migrations/202609240002_align_opening_position_schema.sql');
const fixtureTables=source=>source
 .replaceAll('public.ops_stay_opening_positions','pg_temp.ops_opening_alignment_fixture')
 .replaceAll('public.ops_bookings','pg_temp.ops_alignment_bookings')
 .replaceAll('public.ops_staff','pg_temp.ops_alignment_staff');
test('alignment adds all five used fields without altering existing history or security',()=>{
 const added=[...sql.matchAll(/add column if not exists (\w+)/g)].map(m=>m[1]);
 assert.deepEqual(added,['opening_period','owner_settlement_state','cleaner_settlement_state','owner_settled_cents','cleaner_settled_cents']);
 assert.doesNotMatch(sql,/\b(?:drop table|update public\.|delete from|disable trigger|disable row level security|grant select|create policy)\b/i);
 assert.ok(sql.indexOf('Non-empty legacy')<sql.indexOf('add column if not exists'));
 assert.match(sql,/lock table .* in access exclusive mode/);
});
test('alignment contains full settlement consistency and security safeguards',()=>{
 for(const name of ['owner_state','cleaner_state','owner_amount','cleaner_amount','state_agreement','owner_outstanding','cleaner_outstanding','owner_partial','cleaner_partial','attestation','state','reason','cutoff'])assert.ok(sql.includes('ops_opening_align_'+name));
 for(const guard of ['relrowsecurity','pg_policy','has_table_privilege','ops_no_change()','ops_audit_change()','foreign key','primary key'])assert.ok(sql.includes(guard));
});
test('SQL legacy/fresh upgrade fixture executes exact alignment body, not a mock',()=>{
 const fixture=read('tests/opening-position-schema-upgrade.sql');
 const actual=fixtureTables(sql.slice(sql.indexOf('lock table'),sql.lastIndexOf('commit;')));
 assert.equal(fixture.split('execute $alignment$\n')[1].split('$alignment$;')[0],actual);
 for(const marker of ['Legacy EMPTY','Non-empty legacy','Fresh/current','Expected security refusal','rollback;'])assert.ok(fixture.includes(marker));
});

test('fresh SQL fixture matches original current schema, not the deployed legacy table',()=>{
 const original=fixtureTables(read('supabase/migrations/202609230001_stay_finances.sql').split('create table public.ops_stay_opening_positions (')[1].split('\n);')[0]);
 const fixture=read('tests/opening-position-schema-upgrade.sql').split('-- Fresh/current schema:')[1].split('create temporary table ops_opening_alignment_fixture (')[1].split('\n);')[0];
 assert.equal(fixture,original);
});

test('temporary FK dependencies cover both upgrade and fresh-schema paths',()=>{
 const fixture=read('tests/opening-position-schema-upgrade.sql');
 assert.doesNotMatch(fixture,/public\.ops_(bookings|staff)\b/);
 assert.match(fixture,/create temporary table ops_alignment_bookings \(id uuid primary key\)/);
 assert.match(fixture,/create temporary table ops_alignment_staff \(user_id uuid primary key\)/);
 for(const label of ['Foreign keys escape temporary fixtures','Incorrect FK column mapping','Incorrect opening defaults'])assert.ok(fixture.includes(label));
 // Permanent migration still binds to real tables; only the test remaps them.
 assert.ok(sql.includes("'public.ops_bookings'::regclass"));
 assert.ok(sql.includes("'public.ops_staff'::regclass"));
});
test('fixture security still checks actual function identities and roles without real-table DML',()=>{
 const fixture=read('tests/opening-position-schema-upgrade.sql');
 for(const identity of ['public.ops_can','public.ops_no_change()','public.ops_audit_change()','has_table_privilege','finance_read'])assert.ok(fixture.includes(identity));
 assert.doesNotMatch(fixture,/\b(?:insert into|update|delete from|alter table|drop table) public\./i);
 assert.match(fixture,/rollback;\s*$/);
});
