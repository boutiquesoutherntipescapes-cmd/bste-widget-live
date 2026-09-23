import { collectBookings, ImportError } from './beds24-operations-import.js';
import { operationsConfig, operationsRequest } from './operations-store.js';
import { presentDashboard } from './operations-model.js';
import { StaffAuthError } from './staff-auth.js';
export async function loadDashboard(token, request = operationsRequest) {
  const { account } = operationsConfig();
  const [rows, runs, successes] = await Promise.all([
    request('rpc/ops_dashboard_rows', token, { method:'POST', body:{ account_key:account } }),
    request(`ops_sync_runs?source_account=eq.${encodeURIComponent(account)}&order=started_at.desc&limit=1`, token),
    request(`ops_sync_runs?source_account=eq.${encodeURIComponent(account)}&status=eq.succeeded&order=started_at.desc&limit=1`, token)
  ]);
  if (!Array.isArray(rows) || !Array.isArray(runs) || !Array.isArray(successes)) throw new StaffAuthError(503, 'Dashboard data is unavailable');
  return presentDashboard(rows, [...runs, ...successes.filter(r => !runs.some(a=>a.id===r.id))]);
}
export async function refreshBookings(token, { request = operationsRequest, collect = collectBookings } = {}) {
  const { account } = operationsConfig();
  if (process.env.BSTE_BEDS24_IMPORT_ENABLED !== 'true' || !process.env.BEDS24_LONG_LIFE_TOKEN
      || !process.env.BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY) {
    throw new StaffAuthError(503, 'Read-only staging import is not enabled/configured');
  }
  const run = await request('rpc/ops_begin_sync', token, {method:'POST',body:{account_key:account}});
  try {
    const batch = await collect({ token: process.env.BEDS24_LONG_LIFE_TOKEN, account });
    const imported = await request('rpc/ops_apply_sync', null, { method:'POST', service:true, body:{target_run:run,items:batch.items} });
    return { imported, property_counts:batch.counts };
  } catch (error) {
    try {
      await request('rpc/ops_fail_sync', null, {method:'POST', service:true,
        body:{target_run:run,failure_code:error instanceof ImportError ? error.code : 'storage_failed'}});
    } catch { /* UI must still report failure; abandoned runs age into failure on next attempt. */ }
    throw new StaffAuthError(503, 'Refresh failed. The previous saved snapshot remains; check synchronization diagnostics.');
  }
}
