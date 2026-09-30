import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {requireStaff,assertStaffOrigin,StaffAuthError} from '../lib/staff-auth.js';
import {operationsConfig,operationsRequest} from '../lib/operations-store.js';
import {validCleaningTimestamp} from '../lib/stay-readiness.js';
const uuid=v=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v||'');
const hash=v=>createHash('sha256').update(v).digest('hex');
const safeErrors=['Checkpoint changed; reload saved readiness','Checkpoint not applicable','Replacement prompt changed; reload','Action expired or checklist changed; reload preview','Booking no longer eligible','Cleaning completion cannot precede departure'];
export function createReadinessHandler({authorize=requireStaff,request=operationsRequest,configure=operationsConfig,origin=assertStaffOrigin,now=Date.now}={}){
 // Raw random capabilities are memory-only. The database is authoritative for
 // issuance identity. Cache loss NEVER silently creates a second active set.
 const capabilities=new Map();
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  try{
   const cfg=configure();
   if(req.method!=='POST')throw new StaffAuthError(405,'POST required');
   origin(req);
   if(!String(req.headers?.['content-type']||'').startsWith('application/json'))throw new StaffAuthError(415,'JSON required');
   const b=req.body||{};
   if(JSON.stringify(b).length>6000)throw new StaffAuthError(413,'Request too large');
   if(!['read','generate','preview','respond','cleaner'].includes(b.action))throw new StaffAuthError(400,'Unknown readiness action');
   if(b.environment!==undefined&&b.environment!=='staging')throw new StaffAuthError(403,'Environment mismatch');
   const {token}=await authorize(req,b.action==='read'?'operations.read':'operations.write');
   const rpc=(name,body)=>request('rpc/'+name,token,{method:'POST',body,safeErrors});
   let result;
   if(b.action==='read')result=await rpc('ops_readiness_read',{account_key:cfg.account});
   if(b.action==='generate'){
    if(!uuid(b.booking_id))throw new StaffAuthError(400,'Booking required');
    result=await rpc('ops_readiness_generate',{target_booking:b.booking_id});
   }
   if(b.action==='preview'){
    if(!uuid(b.checkpoint_id)||!Number.isSafeInteger(b.revision)||b.revision<1||(b.replace_prompt_id!=null&&!uuid(b.replace_prompt_id)))throw new StaffAuthError(400,'Checkpoint revision required');
    for(const [key,item] of capabilities)if(item.created<now()-3600000)capabilities.delete(key);
    const context=`${cfg.ref}:${hash(token)}:${b.checkpoint_id}:${b.revision}:staging`;
    const key=context+':'+(b.replace_prompt_id||'initial');
    if(!capabilities.has(key)){
     if(capabilities.size>=500)capabilities.delete(capabilities.keys().next().value);
     capabilities.set(key,{id:randomUUID(),context,created:now(),tokens:Object.fromEntries(['yes','no','tomorrow'].map(a=>[a,randomBytes(32).toString('base64url')]))});
    }
    const candidate=capabilities.get(key);
    const raw=await rpc('ops_readiness_prompt',{target_checkpoint:b.checkpoint_id,expected_revision:b.revision,request_id:candidate.id,token_hashes:Object.fromEntries(Object.entries(candidate.tokens).map(([a,t])=>[a,hash(t)])),replace_prompt:b.replace_prompt_id||null,target_environment:'staging'});
    // Resolve capabilities for the database-selected CURRENT generation, not the proposed request ID.
    const issued=[...capabilities.values()].find(i=>i.context===context&&i.id===raw.prompt_id&&Object.entries(i.tokens).every(([a,t])=>hash(t)===raw.token_hashes?.[a]));
    const usable=issued&&!raw.superseded&&Date.parse(raw.expires_at)>now();
    const {token_hashes,...safe}=raw;
    result={...safe,actions:usable?issued.tokens:null,replacement_required:!usable};
   }
   if(b.action==='respond'){
    if(!uuid(b.booking_id)||!/^[A-Za-z0-9_-]{43}$/.test(b.action_token||'')||typeof(b.note??'')!=='string'||(b.note||'').length>2000)throw new StaffAuthError(400,'Invalid response');
    result=await rpc('ops_readiness_respond',{token_digest:hash(b.action_token),response_note:b.note||'',expected_booking:b.booking_id,target_environment:'staging'});
   }
   if(b.action==='cleaner'){
    if(!uuid(b.booking_id)||!['assigned','unassigned','not_required'].includes(b.cleaning_state)||typeof(b.note??'')!=='string'||(b.note||'').length>2000)throw new StaffAuthError(400,'Invalid cleaning arrangement');
    const assigned=b.cleaning_state==='assigned';
    if(assigned&&(typeof b.cleaner_name!=='string'||!b.cleaner_name.trim()||b.cleaner_name.trim().length>120))throw new StaffAuthError(400,'Assigned cleaner name required');
    if(!assigned&&(b.cleaner_name||b.expected_cleaning_at))throw new StaffAuthError(400,'Unassigned/not-required cleaning cannot include a cleaner or time');
    if(b.cleaning_state==='not_required'&&!b.note?.trim())throw new StaffAuthError(400,'Reason for cleaning exemption required');
    if(b.expected_cleaning_at!=null&&!validCleaningTimestamp(b.expected_cleaning_at))throw new StaffAuthError(400,'Finite timestamp with explicit timezone required');
    result=await rpc('ops_readiness_cleaner',{target_booking:b.booking_id,cleaning_state:b.cleaning_state,cleaner:assigned?b.cleaner_name.trim():null,expected:b.expected_cleaning_at??null,arrangement_note:b.note||''});
   }
   return res.status(200).json(result);
  }catch(e){return res.status(e instanceof StaffAuthError?e.status:500).json({error:e instanceof StaffAuthError?e.message:'Readiness action failed. No automatic retry; reload to inspect saved state.'});}
 };
}
export default createReadinessHandler();
