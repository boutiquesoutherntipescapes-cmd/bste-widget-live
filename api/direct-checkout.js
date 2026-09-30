import {createPreparationService,preparationConfig} from '../lib/direct-checkout-preparation.js';
import {QuoteError} from '../lib/direct-pricing.js';
export function createDirectCheckoutHandler({service=createPreparationService(),settings=preparationConfig}={}){
 return async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
 try{const cfg=settings();if(req.method!=='POST')return res.status(405).json({error:'POST_ONLY'});
 if(req.headers?.origin!==cfg.origin)return res.status(403).json({error:'ORIGIN_DENIED'});
 if(String(req.headers['content-type']||'').split(';')[0]!=='application/json')return res.status(415).json({error:'JSON_REQUIRED'});
 if(Buffer.byteLength(JSON.stringify(req.body||{}))>147456)return res.status(413).json({error:'REQUEST_TOO_LARGE'});
 return res.status(200).json(await service(req.body));
 }catch(e){if(['CHECKOUT_IDEMPOTENCY_CONFLICT','QUOTE_ALREADY_PREPARED','QUOTE_EXPIRED','CHECKOUT_NOT_FOUND'].includes(e?.message))return res.status(409).json({error:e.message,payment_enabled:false});return res.status(e instanceof QuoteError?e.status:503).json({error:e instanceof QuoteError?e.message:'CHECKOUT_UNAVAILABLE',payment_enabled:false});}
 };
}
export default createDirectCheckoutHandler();
