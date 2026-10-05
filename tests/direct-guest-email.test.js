import test from 'node:test';
import assert from 'node:assert/strict';
import {sendDirectGuestEmail, DIRECT_GUEST_SENDER} from '../lib/direct-guest-email.js';
const id='11111111-1111-4111-8111-111111111111';
const env={BSTE_GUEST_LIVE_SENDING:'true',BSTE_GUEST_DIRECT_SENDING:'true',BSTE_GMAIL_CLIENT_ID:'fixture',BSTE_GMAIL_CLIENT_SECRET:'fixture',BSTE_GMAIL_REFRESH_TOKEN:'fixture'};
const args={communicationId:id,recipient:'guest@example.test',subject:'Thank you 🌊',message:'Hello 🌊',env};
const reply=(json,status=200)=>({ok:status<300,status,json:async()=>json});
test('Gmail refuses default-off flags, incomplete config and injected recipient before network',async()=>{
 for(const change of [{env:{...env,BSTE_GUEST_DIRECT_SENDING:'false'}},{env:{...env,BSTE_GUEST_LIVE_SENDING:'false'}},{env:{...env,BSTE_GMAIL_REFRESH_TOKEN:''}},{recipient:'guest@example.test\r\nBcc: other@example.test'},{subject:'Hello\nBcc: other@example.test'}]){
  await assert.rejects(sendDirectGuestEmail({...args,...change,fetcher:()=>assert.fail('network called')}));
 }
});
test('Gmail binds correct mailbox, MIME sender/reply/recipient and records provider id',async()=>{
 const calls=[];
 const result=await sendDirectGuestEmail({...args,fetcher:async(url,options)=>{
  calls.push(url);if(url.includes('oauth2'))return reply({access_token:'fixture'});
  assert.ok(url.includes(encodeURIComponent(DIRECT_GUEST_SENDER)));
  const mime=Buffer.from(JSON.parse(options.body).raw,'base64url').toString();
  assert.match(mime,/Reply-To: boutiquesoutherntipescapes@gmail.com/);assert.match(mime,/To: guest@example.test\r\n/);
  assert.match(mime,/Message-ID: <bste-11111111/);assert.ok(mime.endsWith(Buffer.from('Hello 🌊').toString('base64')));
  return reply({id:'gmail-provider-id'});
 }});
 assert.equal(result.provider_message_id,'gmail-provider-id');assert.equal(calls.length,2);
});
test('lost/invalid/5xx email acknowledgements are uncertain and never retried',async()=>{
 for(const response of [null,reply({},200),reply({},503)]){
  let writes=0;await assert.rejects(sendDirectGuestEmail({...args,fetcher:async(url)=>{
   if(url.includes('oauth2'))return reply({access_token:'fixture'});writes++;if(!response)throw Error('lost');return response;
  }}),e=>e.code==='provider_outcome_uncertain');assert.equal(writes,1);
 }
});
