import { StaffAuthError } from './staff-auth.js';
export function operationsConfig(env = process.env) {
  const ref = env.BSTE_OPERATIONS_STAGING_PROJECT_REF;
  const url = env.BSTE_STAFF_SUPABASE_URL;
  if (env.BSTE_STAFF_ENV !== 'staging' || env.BSTE_OPERATIONS_ENABLED !== 'true'
      || env.VERCEL_ENV === 'production' || !/^[a-z0-9]{20}$/.test(ref || '')
      || url !== `https://${ref}.supabase.co` || !env.BSTE_STAFF_SUPABASE_PUBLIC_KEY
      || !/^[a-zA-Z0-9_-]{1,120}$/.test(env.BSTE_BEDS24_ACCOUNT_KEY || '')) {
    throw new StaffAuthError(503, 'Operations staging is not configured');
  }
  return { url, key: env.BSTE_STAFF_SUPABASE_PUBLIC_KEY, account: env.BSTE_BEDS24_ACCOUNT_KEY, ref };
}
export async function operationsRequest(path, token, { method = 'GET', body, service = false, fetcher = fetch } = {}) {
  const cfg = operationsConfig();
  let key = cfg.key;
  if (service) {
    key = process.env.BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new StaffAuthError(503, 'Staging importer storage is not configured');
    if (!key.startsWith('sb_secret_')) {
      try {
        const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
        if (claims.role !== 'service_role' || claims.ref !== cfg.ref) throw new Error();
      } catch { throw new StaffAuthError(503, 'Staging importer key does not match the configured project'); }
    }
  }
  const bearer = service ? (key.startsWith('sb_secret_') ? null : key) : token;
  let response;
  try {
    response = await fetcher(`${cfg.url}/rest/v1/${path}`, { method,
      headers: { apikey: key, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  } catch { throw new StaffAuthError(503, 'Operations storage is temporarily unavailable'); }
  if (!response.ok) throw new StaffAuthError(response.status === 409 ? 409 : 503,
    response.status === 409 ? 'Another refresh is running, or the record conflicts with saved data' : 'Operations storage rejected the request; saved data has not been replaced');
  if (response.status === 204) return null;
  try { const content = await response.text(); return content ? JSON.parse(content) : null; }
  catch { throw new StaffAuthError(503, 'Invalid operations storage response'); }
}
