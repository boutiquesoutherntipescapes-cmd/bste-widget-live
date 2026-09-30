import {createHash} from 'node:crypto';
import {parseMonthsSpec,seasonForDate,dateRangeList} from '../api/utils.js';
import {paymentSchedule,sastCalendarDate} from './direct-checkout-model.js';
export class QuoteError extends Error {constructor(code,status=400){super(code);this.status=status;}}
const fail=(code)=>{throw new QuoteError(code);};
export function calendarDate(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))fail('INVALID_DATES');const d=new Date(v+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==v)fail('INVALID_DATES');return +d;}
export function zarCents(v){const s=String(v);if(!/^\d+(?:\.\d{1,2})?$/.test(s))fail('INVALID_PRICE_CONFIG');const [whole,decimal='']=s.split('.');const n=BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0'));if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('INVALID_PRICE_CONFIG');return Number(n);}
export function priceStay(prop,arrival,departure,currency='ZAR'){
 if(!prop||currency!=='ZAR')fail('INVALID_PROPERTY_OR_CURRENCY');
 const nights=(calendarDate(departure)-calendarDate(arrival))/86400000;
 if(nights<=0||nights>366)fail('INVALID_STAY_LENGTH');
 const seasons=(prop.seasons||[]).map(s=>({name:s.season_name,months:parseMonthsSpec(s.months),rate:zarCents(s.nightly_rate_zar),cleaning:zarCents(s.cleaning_fee_zar),minStay:s.min_stay_nights}));
 if(seasons.some(s=>!Number.isInteger(s.minStay)||s.minStay<1||s.rate<=0))fail('INVALID_PRICE_CONFIG');
 // Reject overlapping month definitions rather than silently taking the first.
 for(let m=1;m<=12;m++)if(seasons.filter(s=>s.months.includes(m)).length!==1)fail('AMBIGUOUS_SEASON_CONFIG');
 if(seasons.filter(s=>String(s.name).toLowerCase().includes('shoulder')).length>1)fail('AMBIGUOUS_SEASON_CONFIG');
 let subtotal=0,minStay=1;const cleaning=new Set();
 const breakdown=dateRangeList(arrival,nights).map(date=>{const s=seasonForDate(date,seasons);if(!s)fail('MISSING_SEASON');subtotal+=s.rate;minStay=Math.max(minStay,s.minStay);cleaning.add(s.cleaning);return {date,season:s.easterOverride?'Shoulder Season (Easter Weekend)':s.name,rate_cents:s.rate};});
 if(cleaning.size!==1)fail('CLEANING_RULE_REQUIRES_REVIEW');
 const cleaningCents=[...cleaning][0],total=subtotal+cleaningCents;if(!Number.isSafeInteger(total))fail('INVALID_PRICE_CONFIG');
 return {currency,nights,breakdown,accommodation_cents:subtotal,cleaning_cents:cleaningCents,total_cents:total,min_stay_required:minStay,min_stay_ok:nights>=minStay};
}
export function legacyPrice(prop,arrival,departure,currency='ZAR'){
 try {const q=priceStay(prop,arrival,departure,currency);return {ok:true,currency,nights:q.nights,minStayRequired:q.min_stay_required,minStayOk:q.min_stay_ok,total:q.total_cents/100};}catch(e){return {ok:false,error:e instanceof QuoteError?e.message:'INVALID_PRICE_CONFIG'};}
}
export function validateOccupancy(rule,adults,children){
 if(!rule||!Number.isInteger(rule.max_total_guests))throw new QuoteError('CAPACITY_NOT_CONFIGURED',503);
 const adultLimit=rule.adult_only_max!==undefined?(children===0?rule.adult_only_max:rule.family_max_adults):rule.max_adults;
 if(!Number.isInteger(adults)||adults<1||!Number.isInteger(children)||children<0
  ||adults+children>rule.max_total_guests||!Number.isInteger(adultLimit)||adults>adultLimit
  ||(rule.max_children!==undefined&&children>rule.max_children))fail('INVALID_OCCUPANCY');
}
export function authoritativeQuote(config,input,{checkoutProperties,termsVersion,termsUrl,now=new Date()}={}){
 const props=Array.isArray(config)?config:config.properties;
 const rule=checkoutProperties?.[input.property_slug];if(rule?.checkout_enabled===false)fail('PROPERTY_CHECKOUT_DISABLED');
 const prop=props?.find(p=>p.property_slug===input.property_slug);if(!prop)fail('INVALID_PROPERTY');
 if(rule?.checkout_enabled!==true)throw new QuoteError('CAPACITY_NOT_CONFIGURED',503);
 validateOccupancy(rule,input.adults,input.children);
 if(!termsVersion||!termsUrl)throw new QuoteError('TERMS_NOT_CONFIGURED',503);
 const today=sastCalendarDate(now);if(calendarDate(input.arrival)<calendarDate(today))fail('ARRIVAL_IN_PAST');
 const q=priceStay(prop,input.arrival,input.departure,config.currency||'ZAR');if(!q.min_stay_ok)fail('MINIMUM_STAY_NOT_MET');
 const schedule=paymentSchedule(q.total_cents,input.arrival,today);
 const version=createHash('sha256').update(JSON.stringify({engine:'bste-nightly-v1-easter-shoulder-cleaning-unambiguous',property:prop.property_slug,seasons:prop.seasons,occupancy:rule,currency:q.currency,termsVersion,termsUrl})).digest('hex');
 return {property_slug:prop.property_slug,arrival:input.arrival,departure:input.departure,adults:input.adults,children:input.children,...q,
 due_now_cents:schedule.dueNowCents,balance_cents:schedule.balanceCents,balance_due_date:schedule.balanceDueDate,balance_deadline:schedule.balanceDeadline,schedule_date:today,pricing_version:version,terms_version:termsVersion,terms_url:termsUrl};
}
