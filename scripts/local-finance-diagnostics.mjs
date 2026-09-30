// Local HTTPS staging diagnostics only. Never serialize provider payloads verbatim.
import { StaffAuthError } from '../lib/staff-auth.js';
import { operationsRequest } from '../lib/operations-store.js';
import { createFinanceHandler } from '../api/staff-finances.js';
import { assertLocalPreview } from './local-september-preview.mjs';
const safeMessages=new Set(["Active MFA administrator repair authorization required", "Active staff required", "Administrator repair required", "Agreed nightly rate outside allowed range", "Agreed rate must be non-negative integer cents", "Append-only history: add a correction instead", "Approved expense correction requires approval authority", "Approved preview required", "Approved three-stay identities conflict", "Automation enrollment cannot be reset", "Batch guest identity/approval conflict", "Bond confirmation required", "Bond confirmation required for prior settlement", "Configure owner rates for every stay night", "Conflicting data at same source revision", "Conflicting financial data at same source revision", "Conflicting financial snapshot", "Conflicting snapshot at same observation time", "Correction must belong to same booking", "Cutover authority required (administrator only)", "Dashboard capacity exceeded", "Duplicate expense reference; correct the existing entry", "Duplicate historical source identity", "Exceptional reservation cannot be batch-settled", "Existing opening decision conflicts; not overwritten", "Expense approval authority required", "Expense property must match stay at entry", "Expense reconciliation incomplete", "Financial MFA access required", "Financial identity cannot change", "Financial input too large", "Financial snapshot must come from the same source observation", "Fresh historical preview required", "Funds evidence date cannot be in future", "Historical approval expired or revoked", "Historical importer only", "Historical opening state incomplete or conflicting; administrator repair required; do not retry import", "Historical scope violation", "Importer only", "Inactive sync run", "Invalid event", "Invalid expense amount", "Invalid historical batch", "Invalid import batch", "Invalid obligation state", "Invalid opening state", "MFA administrator historical approval required", "MFA required", "Named active staff required", "Nightly rates must be an array", "Non-empty legacy opening table: explicit reviewed per-row mapping required; no defaults/backfill applied", "Non-guest reservation cannot be batch-settled", "Normal sync running", "Normal sync running; retry after completion", "Not the legacy partial three-stay September batch", "Opening RLS/policy drift: review separately; alignment rolled back", "Opening audit/immutability trigger drift: review separately; alignment rolled back", "Opening privilege drift: review separately; alignment rolled back", "Opening state contradicts obligation states", "Opening-period eligibility requires checkout on or before 2026-09-23", "Operational permission required", "Outstanding obligation cannot include prior paid amount", "Overlapping owner rate periods", "Partial settlement requires a known positive paid amount", "Preview already approved with different selection or actor", "Rate configuration authority required", "Reason required for agreed rate adjustment", "Record identity cannot change", "Repair reason required", "Request key already used with different content or actor", "Request key required", "Resolve allocation before approval", "Review authority required", "Settled amount exceeds limit", "Settled amounts must be non-negative integer cents", "Snapshot object required", "Source account required", "Source booking identity cannot change", "Stable task identity cannot change", "Staff access required", "Stale expense revision", "Stale financial revision; reload", "Stale financial snapshot", "Stale rate revision", "Stale source snapshot", "Standard rates changed or night invalid; reload before saving", "Stored booking changed since preview; refresh preview", "Stored booking differs from approved batch", "Supplier, payer and reason required", "Supply every occupied night exactly once", "Sync permission required", "System importer only", "Task key required", "Unknown booking", "Unknown expense", "Unknown historical batch", "Unknown staff actor", "Unpaid opening postcondition failed", "Unsupported expense category; cleaner cost belongs in finance review", "Unsupported financial action", "Unsupported historical status", "Void requires an existing expense", "Wrong import scope or observation", "example safe SQL validation failure"]);
const identifier='[a-z_][a-z0-9_]{0,100}';
function safeMessage(value){
 if(typeof value!=='string'||value.length>2000)return '[message withheld]';
 if(safeMessages.has(value))return value;
 // Standard database templates expose schema identifiers only, never failing row values.
 const patterns=[
  `^new row for relation "(ops_${identifier})" violates check constraint "(${identifier})"$`,
  `^null value in column "(${identifier})" of relation "(ops_${identifier})" violates not-null constraint$`,
  `^duplicate key value violates unique constraint "(ops_${identifier})"$`,
  `^(column|relation) "(${identifier})" does not exist$`,
  `^permission denied for (table|function) (ops_${identifier})$`
 ];
 if(patterns.some(p=>new RegExp(p).test(value)))return value;
 const invalid=value.match(/^invalid input syntax for type (uuid|bigint|integer|boolean|json|date|timestamp with time zone):/);
 if(invalid)return `invalid input syntax for type ${invalid[1]}: [value withheld]`;
 if(/^Could not find the function public\.ops_finance_write\(/.test(value))return 'Could not find public.ops_finance_write with the supplied arguments in the schema cache';
 return '[unrecognized message withheld to protect personal data]';
}
export function financeDiagnostic(status,body){
 const code=typeof body?.code==='string'&&/^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(body.code)?body.code:'unavailable';
 const lines=['Finance save rejected:',`status=${Number.isInteger(status)?status:'unavailable'}`,`code=${code}`,`message=${safeMessage(body?.message)}`];
 for(const field of ['details','hint'])if(body?.[field]!=null){
  // Detail commonly contains the entire rejected row. Default to withholding it.
  const value=body[field];
  lines.push(`${field}=${value==='No function matches the given name and argument types. You might need to add explicit type casts.'?value:'[withheld; may contain row data or credentials]'}`);
 }
 return lines.join('\n');
}
export function createLocalFinanceHandler({fetcher=fetch,log=console.error,...dependencies}={}){
 return async(req,res)=>{
  try{assertLocalPreview(req);}catch{return res.status(403).json({error:'Local staging only'});}
  const request=(path,token,options={})=>operationsRequest(path,token,{...options,fetcher,
   onRejected:path==='rpc/ops_finance_write'&&options.method==='POST'?(status,body)=>{
    const diagnostic=financeDiagnostic(status,body);log(diagnostic);throw new StaffAuthError(409,diagnostic);
   }:undefined});
  return createFinanceHandler({...dependencies,request})(req,res);
 };
}
export default createLocalFinanceHandler();
