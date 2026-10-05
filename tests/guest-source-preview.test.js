import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBeds24GuestSource } from '../lib/guest-communications-source-preview.js';
import { resetBeds24MessagingTokenCacheForTests } from '../lib/beds24-messaging.js';
import { createGuestCommunicationsWorkerHandler } from '../api/guest-communications-worker.js';
const env={BSTE_GUEST_WORKER_MODE:'dry_run',BSTE_GUEST_LIVE_SENDING:'false',BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',BSTE_STAFF_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY:'fixture',BSTE_BEDS24_ACCOUNT_KEY:'fixture-account',BEDS24_REFRESH_TOKEN:'fixture-refresh',CRON_SECRET:'fixture-cron'};
test('source preview only reads, preserves sent history and does not leak contact or Wi-Fi values',async()=>{
 resetBeds24MessagingTokenCacheForTests();const calls=[];
 const fetcher=async(url,options)=>{calls.push({url,options});assert.equal(options.method,'GET');let data;
 if(url.includes('/authentication/token'))data={token:'fixture-token'};
 else if(url.includes('beds24.com')){assert.ok(!url.includes('includeInvoiceItems'));data={data:url.includes('roomId=724919')?[{id:123,roomId:724919,propertyId:351452,arrival:'2026-10-09',departure:'2026-10-11',status:'confirmed',channel:'booking',firstName:'Fixture',lastName:'Guest',email:'private@example.test',numAdult:2}]:[],pages:{nextPageExists:false}};}
 else if(url.includes('/ops_bookings?'))data=[{id:'stored',beds24_booking_id:123,source_account:'fixture-account',source_environment:'production',automation_enrolled_at:'2026-10-01T00:00:00Z'}];
 else data=[{booking_id:'stored',message_key:'pre_arrival',status:'sent',scheduled_at:'2026-10-06T07:00:00Z'}];
 return {ok:true,json:async()=>data};};
 const report=await previewBeds24GuestSource({env:{...env,BSTE_GUEST_WIFI_LEGACY_NETWORK:'private-network',BSTE_GUEST_WIFI_LEGACY_PASSWORD:'private-password'},now:new Date('2026-10-05T08:00:00Z'),fetcher});
 assert.equal(report.queue_mutated,false);assert.equal(report.provider_messages_sent,0);assert.equal(report.bookings.length,1);
 assert.equal(report.bookings[0].messages.find(x=>x.message_key==='pre_arrival').status,'sent');
 assert.ok(report.bookings[0].messages.every(x=>x.automation_enabled===false));
 assert.ok(!JSON.stringify(report).includes('private-password'));assert.ok(!JSON.stringify(report).includes('private@example.test'));
 assert.equal(report.bookings[0].messages.find(x=>x.message_key==='arrival_evening_essentials').render.status,'rendered');
 assert.ok(calls.every(x=>!x.url.includes('/bookings/messages')&&!x.url.includes('/rpc/')));
});
test('unsafe source preview refuses before any request',async()=>{
 for(const unsafe of [{BSTE_GUEST_WORKER_MODE:'live'},{BSTE_GUEST_LIVE_SENDING:'true'}])await assert.rejects(previewBeds24GuestSource({env:{...env,...unsafe},fetcher:()=>{assert.fail('network called');}}));
});
test('preview route requires cron authorization and cannot enter delivery in live mode',async()=>{
 for(const [headers,mode,expected] of [[{},'dry_run',401],[{authorization:'Bearer fixture-cron'},'live',503]]){
 const handler=createGuestCommunicationsWorkerHandler({env:{...env,BSTE_GUEST_WORKER_MODE:mode},previewSource:()=>assert.fail('preview called'),deliver:()=>assert.fail('delivery called')});
 const res={setHeader(){},status(c){this.code=c;return this;},json(b){this.body=b;}};
 await handler({method:'GET',headers,query:{preview_source:'beds24'}},res);assert.equal(res.code,expected);
 }
});

test('new-channel preview works beside live Booking.com using GETs without enabling new channels',async()=>{
 resetBeds24MessagingTokenCacheForTests();
 const fetcher=async(url,options)=>{
  assert.equal(options.method,'GET');let data=[];
  if(url.includes('authentication/token'))data={token:'fixture'};
  else if(url.includes('beds24.com'))data={data:url.includes('roomId=724919')?[
   {id:321,roomId:724919,propertyId:351452,arrival:'2026-10-09',departure:'2026-10-11',status:'new',channel:'airbnb',firstName:'Airbnb',numAdult:2},
   {id:322,roomId:724919,propertyId:351452,arrival:'2026-10-09',departure:'2026-10-11',status:'confirmed',channel:'direct',firstName:'Direct',email:'private@example.test',numAdult:2},
   {id:323,roomId:724919,propertyId:351452,arrival:'2026-10-09',departure:'2026-10-11',status:'request',channel:'direct',firstName:'Pending',numAdult:2},
   {id:324,roomId:724919,propertyId:351452,arrival:'2026-10-09',departure:'2026-10-11',status:'cancelled',channel:'airbnb',firstName:'Cancelled',numAdult:2}
  ]:[],pages:{nextPageExists:false}};
  return {ok:true,json:async()=>data};
 };
 const report=await previewBeds24GuestSource({channel:'new_channels',env:{...env,BSTE_GUEST_WORKER_MODE:'live',BSTE_GUEST_LIVE_SENDING:'true'},fetcher,now:new Date('2026-10-05T10:00:00Z')});
 assert.equal(report.eligible_airbnb_count,1);assert.equal(report.eligible_direct_count,1);assert.equal(report.bookings[1].recipient_available,true);
 assert.equal(report.provider_messages_sent,0);assert.equal(report.queue_mutated,false);assert.ok(!JSON.stringify(report).includes('private@example.test'));
 for(const flag of ['BSTE_GUEST_AIRBNB_SENDING','BSTE_GUEST_DIRECT_SENDING'])await assert.rejects(previewBeds24GuestSource({channel:'new_channels',env:{...env,[flag]:'true'},fetcher:()=>assert.fail('network')}));
});
test('new-channel endpoint cannot dispatch the live Booking.com worker',async()=>{
 const handler=createGuestCommunicationsWorkerHandler({env:{...env,BSTE_GUEST_WORKER_MODE:'live',BSTE_GUEST_LIVE_SENDING:'true'},previewSource:async({channel})=>({channel,preview_only:true}),deliver:()=>assert.fail('live dispatch')});
 const res={setHeader(){},status(c){this.code=c;return this;},json(b){this.body=b;}};
 await handler({method:'GET',headers:{authorization:'Bearer fixture-cron'},query:{preview_source:'beds24',channel:'new_channels'}},res);
 assert.equal(res.code,200);assert.equal(res.body.channel,'new_channels');
});
