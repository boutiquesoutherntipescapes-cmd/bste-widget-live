// No apply mode, no environment auto-loading, no persisted guest payloads.
import {fileURLToPath} from 'node:url';
import {previewHistorical} from '../lib/beds24-historical-backfill.js';
export async function main(args=process.argv.slice(2),{preview=previewHistorical,env=process.env,print=console.log}={}) {
 if(args.length===1&&args[0]==='--help'){print('Preview only: node scripts/preview-september-backfill.mjs --preview\nRequires existing isolated staging settings, BEDS24_LONG_LIFE_TOKEN and BSTE_BACKFILL_STAFF_ACCESS_TOKEN (MFA administrator). Reads Beds24 and staging; never applies or writes. Obtain Bond approval before running.');return;}
 if(args.length!==1||args[0]!=='--preview')throw new Error('Only --help or --preview is supported; no apply mode');
 const result=await preview({staffToken:env.BSTE_BACKFILL_STAFF_ACCESS_TOKEN,token:env.BEDS24_LONG_LIFE_TOKEN});print(JSON.stringify(result.report,null,2));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Historical preview failed. No writes were requested. Verify approved staging configuration, credentials and read access; credentials/provider payloads are not logged.');process.exitCode=1;});
