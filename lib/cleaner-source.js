import {timingSafeEqual} from 'node:crypto';
const homes=[['legacy-suiderstrand',351452,724919],['kalay-ridge-villa-struisbaai',352005,726060],['the-pearl-beach-villa-agulhas',352276,726696],['ctonic-ocean-view-villa',361753,745734]];
let cached=null;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 const secret=process.env.BSTE_CLEANER_SOURCE_SECRET, supplied=String(req.headers?.authorization||'');
 if(!secret||supplied.length!==('Bearer '+secret).length||!timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+secret)))return res.status(401).json({error:'Cleaner authentication rejected',configured:!!secret,authorizationReceived:!!supplied});
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 try{return res.status(200).json(await collectCleanerSource());}catch{return res.status(503).json({error:'Fresh cleaner source unavailable'});}
}
export async function collectCleanerSource({env=process.env,fetcher=fetch,now=new Date()}={}){
 const observedAt=now.toISOString(),today=new Date(+now+7200000).toISOString().slice(0,10),from=new Date(Date.parse(today)-86400000).toISOString().slice(0,10),stays=[],attention=[];
 async function json(url,headers){const r=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Source read failed');return r.json();}
 if(!cached||cached.until<Date.now()){
  if(!env.BEDS24_REFRESH_TOKEN)throw Error('Beds24 unavailable');
  const auth=await json('https://beds24.com/api/v2/authentication/token',{refreshToken:env.BEDS24_REFRESH_TOKEN,accept:'application/json'});
  if(!auth.token)throw Error('Beds24 unavailable');cached={token:auth.token,until:Date.now()+Math.min(300,Number(auth.expiresIn||300))*1000};
 }
 for(const [slug,property,room] of homes){
  for(let page=1;page<=100;page++){
   const u=new URL('https://beds24.com/api/v2/bookings');u.searchParams.set('roomId',room);u.searchParams.set('departureFrom',from);u.searchParams.set('page',page);
   const b=await json(u.toString(),{token:cached.token,accept:'application/json'});
   if(!Array.isArray(b.data)||typeof b.pages?.nextPageExists!=='boolean')throw Error('Incomplete bookings');
   for(const r of b.data){
    if(Number(r.propertyId)!==property||Number(r.roomId)!==room)throw Error('Wrong property');
    if(String(r.comments||'').startsWith('BSTE-TEST:'))continue;
    const status=String(r.status).toLowerCase();if(!['new','confirmed','cancelled'].includes(status))continue;
    // A hosted direct checkout requires ledger verification, never infer payment
    // from a provider status or amount. Keep it out until proof is configured.
    if(r.custom1==='BSTE_DIRECT_CHECKOUT_V2'||(r.custom1==='BSTE_DIRECT_BOOKING'&&String(r.custom2||'').startsWith('BSTE-PF-'))){attention.push({id:String(r.id),reason:'checkout_ledger_verification_required'});continue;}
    const adults=Number(r.numAdult),children=Number(r.numChild||0);
    if(!Number.isSafeInteger(Number(r.id))||!Number.isInteger(adults)||!Number.isInteger(children)||adults<0||children<0)throw Error('Invalid booking');
    stays.push({id:String(r.id),kind:'guest',property_slug:slug,start_date:r.arrival,end_date:r.departure,guests:adults+children,confirmed:status!=='cancelled',cancelled:status==='cancelled'});
   }
   if(!b.pages.nextPageExists)break;if(page===100)throw Error('Incomplete bookings');
  }
 }
 const origin=String(env.SUPABASE_URL||'').replace(/\/rest\/v1\/?$/,'').replace(/\/+$/,'');
 if(origin!=='https://hkblkpenihhkiudmbcxo.supabase.co'||!env.SUPABASE_SERVICE_ROLE_KEY)throw Error('Owner source unavailable');
 for(let offset=0;offset<10000;offset+=500){
  const rows=await json(origin+'/rest/v1/owner_blocks?select=id,property_slug,start_date,end_date,block_type&order=id&limit=500&offset='+offset,{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY});
  if(!Array.isArray(rows))throw Error('Incomplete owner blocks');
  for(const r of rows)if(homes.some(h=>h[0]===r.property_slug)&&['owner_block','owner_existing'].includes(r.block_type))stays.push({...r,kind:'owner'});
  if(rows.length<500)return {observedAt,complete:true,stays,attention};
 }
 throw Error('Incomplete owner blocks');
}
