// Future transport boundary ONLY. Not routed or instantiated by the application.
// processOnce must atomically deduplicate provider+environment+message_id, reject
// fingerprint conflicts, and commit the response with the receipt in one transaction.
import {createHash} from 'node:crypto';
import {normalizeInternalReply} from './stay-readiness.js';
export function createInternalReplyAdapter({environment,verifySender,correlate,processOnce,respond}){
 if(environment!=='staging'||![verifySender,correlate,processOnce,respond].every(f=>typeof f==='function'))throw new Error('Verified, correlated, atomic reply adapter required');
 return async input=>{
  if(input?.environment!==environment)throw new Error('Environment mismatch');
  const staff=await verifySender(input),reference=await correlate(input);
  if(!staff?.authorized||!reference?.authorized||reference.environment!==environment||reference.correlation_id!==input.correlation_id||reference.checkpoint_reference!==input.checkpoint_reference)throw new Error('Reply authorization/correlation failed');
  const normalized=normalizeInternalReply({...input,verified_sender:true,authorized_staff_id:staff.id},{environment});
  const fingerprint=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return processOnce({environment,provider:normalized.provider,message_id:normalized.message_id,fingerprint},()=>respond(normalized));
 };
}
