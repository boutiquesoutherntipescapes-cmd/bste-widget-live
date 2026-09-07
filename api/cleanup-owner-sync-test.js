import { clearBeds24Blackout, setBeds24Blackout } from '../lib/beds24.js';

function cleanSupabaseUrl(url) {
  return String(url || '').trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/g, '');
}
function getSupabase() {
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase credentials');
  return { url, key };
}
async function supabaseFetch(path, options={}) {
  const { url, key } = getSupabase();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type':'application/json',
      Prefer: options.prefer || ''
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
function addDays(dateString, days) {
  const d = new Date(String(dateString) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0,10);
}
function overlaps(aStart,aEnd,bStart,bEnd){
  return String(aStart) < String(bEnd) && String(bStart) < String(aEnd);
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if (String(process.env.VERCEL_ENV || '').toLowerCase() !== 'preview') {
    return res.status(403).json({ok:false,error:'Preview only'});
  }
  if (req.method !== 'GET') return res.status(405).json({ok:false,error:'GET only'});

  const propertySlug='legacy-suiderstrand';
  const start='2027-03-06';
  const end='2027-03-07';
  const mode=String(req.query?.mode || 'inspect');

  try {
    const rows = await supabaseFetch(
      `owner_blocks?select=id,property_slug,start_date,end_date,note,created_by,created_at&property_slug=eq.${encodeURIComponent(propertySlug)}&start_date=eq.${start}&end_date=eq.${end}`
    );
    const matches=(rows||[]).filter(r=>String(r.note||'').toLowerCase().includes('bste sync test'));

    if (mode !== 'delete') {
      return res.status(200).json({ok:true,mode:'inspect',matches,all_rows:rows||[]});
    }
    if (matches.length !== 1) {
      return res.status(409).json({ok:false,error:'Expected exactly one BSTE sync test block',matches,all_rows:rows||[]});
    }

    const target=matches[0];
    const buffer=1;
    const clearStart=addDays(start,-buffer);
    const clearEnd=addDays(end,buffer);

    const others = await supabaseFetch(
      `owner_blocks?select=id,start_date,end_date,note&property_slug=eq.${encodeURIComponent(propertySlug)}&id=neq.${encodeURIComponent(target.id)}`
    );
    const overlapping=(others||[]).filter(o=>{
      const oStart=addDays(o.start_date,-buffer);
      const oEnd=addDays(o.end_date,buffer);
      return overlaps(clearStart,clearEnd,oStart,oEnd);
    });

    await clearBeds24Blackout(propertySlug,clearStart,clearEnd);

    for (const other of overlapping) {
      await setBeds24Blackout(
        propertySlug,
        addDays(other.start_date,-buffer),
        addDays(other.end_date,buffer)
      );
    }

    await supabaseFetch(
      `owner_blocks?id=eq.${encodeURIComponent(target.id)}&property_slug=eq.${encodeURIComponent(propertySlug)}`,
      {method:'DELETE',prefer:'return=minimal'}
    );

    return res.status(200).json({
      ok:true,
      deleted:target,
      cleared:{start:clearStart,end:clearEnd},
      overlapping_reapplied:overlapping
    });
  } catch (err) {
    return res.status(500).json({ok:false,error:String(err)});
  }
}
