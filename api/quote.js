import fs from 'node:fs';
import {priceStay,QuoteError} from '../lib/direct-pricing.js';
// Legacy display endpoint. Durable preparation uses /api/direct-checkout instead.
export default async function handler(req,res){
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Cache-Control','no-store');
 res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'POST only'});
 try{const config=JSON.parse(fs.readFileSync(new URL('../config/properties.json',import.meta.url),'utf8'));const {property_slug,check_in,check_out}=req.body||{};
 const prop=(Array.isArray(config)?config:config.properties).find(p=>p.property_slug===property_slug);const q=priceStay(prop,check_in,check_out,config.currency||'ZAR');
 return res.status(200).json({currency:q.currency,nights:q.nights,min_stay_required:q.min_stay_required,min_stay_ok:q.min_stay_ok,subtotal_nightly:q.accommodation_cents/100,cleaning_fee_zar:q.cleaning_cents/100,total_price_zar:q.total_cents/100,breakdown:q.breakdown.map(n=>({date:n.date,season:n.season,nightly_rate_zar:n.rate_cents/100})),inventory_protected:false,availability:'preliminary_only'});
 }catch(e){return res.status(e instanceof QuoteError?e.status:503).json({error:e instanceof QuoteError?e.message:'QUOTE_UNAVAILABLE'});}
}
