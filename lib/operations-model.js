export const PROPERTIES = Object.freeze([
  { slug: 'legacy-suiderstrand', name: 'Legacy Beach Villa', propertyId: 351452, roomId: 724919 },
  { slug: 'kalay-ridge-villa-struisbaai', name: 'Kalaya Ridge Villa', propertyId: 352005, roomId: 726060 },
  { slug: 'the-pearl-beach-villa-agulhas', name: 'The Pearl Beach Villa', propertyId: 352276, roomId: 726696 }
]);
export const ACTIVE_STATUSES = ['new', 'confirmed', 'request'];
export function sastDate(now = new Date()) {
  return new Date(now.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
}
export function presentDashboard(rows, runs, now = new Date()) {
  const today = sastDate(now);
  const last = runs[0] || null;
  const success = runs.find(r => r.status === 'succeeded');
  const interrupted = last?.status === 'running' && now - new Date(last.started_at) > 10 * 60_000;
  const stale = interrupted || !success || now - new Date(success.completed_at) > 30 * 60_000;
  const bookings = rows.map(row => {
    const raw = String(row.source_status || '').toLowerCase();
    const attention = [];
    const operational = row.operational_status || (raw === 'confirmed' ? 'confirmed' : raw === 'new' ? 'active_from_source' : 'review_required');
    const operationalReviewed = ['confirmed', 'checked_in', 'checked_out'].includes(row.operational_status);
    if (raw === 'request' && !operationalReviewed) attention.push('Beds24 request: verify operational status');
    if (!ACTIVE_STATUSES.includes(raw)) attention.push(`Beds24 status ${row.source_status}: review before operating`);
    if (row.not_seen_in_latest_sync) attention.push('Not returned in latest complete sync; do not assume cancelled');
    if (!row.guest_email && !row.guest_mobile) attention.push('No guest contact supplied');
    if (row.payment_visible && !row.payment_status) attention.push('Payment not reviewed');
    if (stale || last?.status === 'failed') attention.push('Source data needs refresh');
    return { ...row, operational_status: operational, operational_is_manual: !!row.operational_status,
      group: row.departure === today ? 'departing_today' : row.arrival <= today && row.departure > today ? 'in_house' : 'upcoming',
      attention };
  }).sort((a,b) => a.arrival.localeCompare(b.arrival) || String(a.beds24_booking_id).localeCompare(String(b.beds24_booking_id)));
  return { today, bookings, properties: PROPERTIES.map(p => ({ ...p,
    count: bookings.filter(b => b.property_slug === p.slug).length })),
    diagnostics: { last_attempt: last, last_success: success || null, stale,
      warning: last?.status === 'failed' ? 'Latest refresh failed. Showing the last saved data.' : interrupted ? 'Refresh appears interrupted. Showing the previous saved data.' : stale ? 'Data is stale or has never been synchronized.' : last?.status === 'running' ? 'Refresh is running. Showing the previous saved data.' : null } };
}
