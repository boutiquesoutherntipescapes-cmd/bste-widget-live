import fs from 'node:fs';
import {createHmac,createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {authoritativeQuote,QuoteError} from './direct-pricing.js';
import {holdConfig} from './direct-checkout-model.js';
import {operationsConfig,operationsRequest} from './operations-store.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const deny=(code,status=400)=>{throw new QuoteError(code,status);};
function exact(obj,keys){if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!keys.includes(k)))deny('INVALID_FIELDS');}
export function preparationConfig(env=process.env){
 operationsConfig(env);
 if(env.BSTE_CHECKOUT_ENABLED!=='true'||env.BSTE_STAFF_ENV!=='staging'||env.VERCEL_ENV==='production')deny('CHECKOUT_DISABLED',503);
 if(!env.BSTE_CHECKOUT_SIGNING_KEY||Buffer.byteLength(env.BSTE_CHECKOUT_SIGNING_KEY)<32)deny('CHECKOUT_NOT_CONFIGURED',503);
 let origin;try{origin=new URL(env.BSTE_CHECKOUT_ORIGIN);if(origin.protocol!=='https:'||origin.origin!==env.BSTE_CHECKOUT_ORIGIN)throw Error();}catch{deny('CHECKOUT_NOT_CONFIGURED',503);}
 const checkoutProperties=JSON.parse(fs.readFileSync(new URL('../config/checkout-properties.json',import.meta.url),'utf8'));
 if(!/^[A-Za-z0-9._-]{1,100}$/.test(env.BSTE_CHECKOUT_TERMS_VERSION||''))deny('TERMS_NOT_CONFIGURED',503);
 try{if(new URL(env.BSTE_CHECKOUT_TERMS_URL).protocol!=='https:')throw Error();}catch{deny('TERMS_NOT_CONFIGURED',503);}
 return {key:env.BSTE_CHECKOUT_SIGNING_KEY,origin:origin.origin,checkoutProperties,termsVersion:env.BSTE_CHECKOUT_TERMS_VERSION,termsUrl:env.BSTE_CHECKOUT_TERMS_URL,holdMinutes:holdConfig(env).holdMinutes};
}
function encode(payload,key){const data=Buffer.from(JSON.stringify(payload)).toString('base64url');return data+'.'+createHmac('sha256',key).update(data).digest('base64url');}
function decode(token,key){
 if(typeof token!=='string'||token.length>131072)deny('INVALID_QUOTE',403);const parts=token.split('.');if(parts.length!==2)deny('INVALID_QUOTE',403);
 const mac=createHmac('sha256',key).update(parts[0]).digest();const supplied=Buffer.from(parts[1],'base64url');if(mac.length!==supplied.length||!timingSafeEqual(mac,supplied))deny('INVALID_QUOTE',403);
 let p;try{p=JSON.parse(Buffer.from(parts[0],'base64url'));}catch{deny('INVALID_QUOTE',403);}
 if(p.version!==1||p.environment!=='sandbox'||!uuid(p.quote_reference)||typeof p.access!=='string'||!p.quote)deny('INVALID_QUOTE',403);return p;
}
export function normalizedGuest(g){
 exact(g,['first_name','surname','email','mobile']);const out={};
 for(const k of ['first_name','surname']){if(typeof g[k]!=='string'||g[k].trim().length<1||g[k].trim().length>100||/[\x00-\x1f\x7f]/.test(g[k]))deny('INVALID_GUEST');out[k]=g[k].trim();}
 if(typeof g.email!=='string'||g.email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(g.email)||/[\r\n]/.test(g.email))deny('INVALID_EMAIL');out.email=g.email.trim().toLowerCase();
 if(typeof g.mobile!=='string'||!/^\+?[0-9 ()-]{7,30}$/.test(g.mobile))deny('INVALID_MOBILE');out.mobile=g.mobile.replace(/[ ()-]/g,'');if(out.mobile.replace('+','').length<7||out.mobile.replace('+','').length>15)deny('INVALID_MOBILE');return out;
}
export function preparationRequest(path,body){
 if(!['rpc/direct_prepare_checkout','rpc/direct_checkout_status'].includes(path))deny('UNSUPPORTED_STORAGE_PATH',503);
 return operationsRequest(path,null,{method:'POST',body,service:true,safeErrors:['CHECKOUT_IDEMPOTENCY_CONFLICT','QUOTE_ALREADY_PREPARED','QUOTE_EXPIRED','CHECKOUT_NOT_FOUND']});
}
export function createPreparationService({config=()=>JSON.parse(fs.readFileSync(new URL('../config/properties.json',import.meta.url),'utf8')),settings=()=>preparationConfig(),request=preparationRequest,now=()=>new Date()}={}){
 return async function run(body){
  const cfg=settings();exact(body,['action','property_slug','arrival','departure','adults','children','quote_token','idempotency_key','guest','terms_version','terms_accepted','checkout_id']);
  if(body.action==='quote'){
   exact(body,['action','property_slug','arrival','departure','adults','children']);
   const time=now(),quote=authoritativeQuote(config(),body,{...cfg,now:time});
   const p={version:1,environment:'sandbox',quote_reference:randomUUID(),created_at:time.toISOString(),expires_at:new Date(+time+30*60000).toISOString(),access:randomBytes(32).toString('base64url'),quote,hold_minutes:cfg.holdMinutes};
   return {quote,...{quote_reference:p.quote_reference,expires_at:p.expires_at,quote_token:encode(p,cfg.key)},inventory_protected:false,payment_enabled:false};
  }
  if(body.action==='status'){
   exact(body,['action','checkout_id','quote_token']);if(!uuid(body.checkout_id))deny('INVALID_CHECKOUT');const p=decode(body.quote_token,cfg.key);
   return request('rpc/direct_checkout_status',{target:body.checkout_id,access_hash:sha(p.access)});
  }
  if(body.action!=='prepare')deny('INVALID_ACTION');
  exact(body,['action','quote_token','idempotency_key','guest','terms_version','terms_accepted']);
  if(!uuid(body.idempotency_key)||body.terms_accepted!==true)deny('INVALID_ACCEPTANCE');
  const p=decode(body.quote_token,cfg.key),time=now();if(+time>=Date.parse(p.expires_at))deny('QUOTE_EXPIRED',409);
  if(body.terms_version!==cfg.termsVersion||p.quote.terms_version!==cfg.termsVersion)deny('TERMS_CHANGED',409);
  const fresh=authoritativeQuote(config(),p.quote,{...cfg,now:time});if(JSON.stringify(fresh)!==JSON.stringify(p.quote)||p.hold_minutes!==cfg.holdMinutes)deny('QUOTE_CHANGED',409);
  const prepared={quote:p.quote,quote_reference:p.quote_reference,quote_created_at:p.created_at,quote_expires_at:p.expires_at,hold_minutes:p.hold_minutes,
   idempotency_key:body.idempotency_key.toLowerCase(),guest:normalizedGuest(body.guest),access_hash:sha(p.access)};
  return request('rpc/direct_prepare_checkout',{prepared});
 };
}
