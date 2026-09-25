// Pure draft calculations. No provider calls or writes; all amounts are ZAR cents.
export function draftStay(finance, expenses = [], opening = null, booking = null, today = new Date().toISOString().slice(0,10)) {
  const historical=opening?.state==='fully_settled_historical';
  const ownerState=opening?.owner_settlement_state||(historical?'fully_settled':'outstanding');
  const cleanerState=opening?.cleaner_settlement_state||(historical?'fully_settled':'outstanding');
  const openingPeriod=opening?.opening_period===true||historical;
  const complete=!!booking?.departure&&booking.departure<=today;
  const position={opening_period:openingPeriod,opening_period_eligible:!!booking?.departure&&booking.departure<='2026-09-23',
    completed:complete,owner_settlement_state:ownerState,cleaner_settlement_state:cleanerState,
    settlement_state:ownerState==='fully_settled'&&cleanerState==='fully_settled'?'fully_settled':ownerState==='outstanding'&&cleanerState==='outstanding'?'outstanding':'partially_settled',
    monthly_reconciliation_eligible:complete&&!historical};
  if (!finance) {
    return { ...position, label:'Draft', eligibility:historical?'historical_settled':'needs_review',
      exclude_from_new_payables:historical,cleaner_monthly_candidate_cents:0,missing:historical?[]:['Financial review required'] };
  }
  const cents = v => { if (!Number.isSafeInteger(Number(v)) || Number(v)<0) throw new Error('Invalid money value'); return Number(v); };
  const current=expenses.filter(e=>!expenses.some(n=>n.previous_id===e.id));
  const active=current.filter(e=>!e.is_void);
  const approved=active.filter(e=>e.status==='approved'&&e.allocation!=='needs_review');
  const sum=(rows,key)=>rows.reduce((n,e)=>n+cents(e[key]??0),0);
  const ownerGross=finance.rate_nights.reduce((n,r)=>n+cents(r.rate_cents),0);
  const accommodation=cents(finance.accommodation_cents),cleaning=cents(finance.cleaning_charge_cents),fees=cents(finance.channel_fees_cents),cleaner=cents(finance.cleaner_cost_cents);
  const ownerCosts=sum(approved,'owner_amount_cents');
  const bsteCosts=sum(approved,'bste_amount_cents');
  const ownerPayout=ownerGross-ownerCosts;
  const accommodationContribution=accommodation-fees-ownerGross, cleaningContribution=cleaning-cleaner;
  const expectedFunds=Math.max(0,accommodation+cleaning-fees),received=cents(finance.funds_received_cents);
  const basis=finance.source_basis?.booking;
  const sourceChanged=!!booking&&!!basis&&['arrival','departure','property_slug','source_status'].some(k=>booking[k]!==basis[k]);
  const missing=[];
  if(finance.expenses_complete!==true)missing.push('Expense capture and reconciliation not complete');
  if(fees>accommodation+cleaning)missing.push('Channel fees exceed reviewed revenue');
  if(finance.rate_nights.length===0)missing.push('Owner rate coverage missing');
  if(finance.status!=='reviewed')missing.push('Administrator financial review required');
  if(active.some(e=>e.status!=='approved'||e.allocation==='needs_review'))missing.push('Unapproved or unresolved expenses');
  if(sourceChanged)missing.push('Booking changed since review');
  if(booking?.source_status&&!['new','confirmed','request'].includes(booking.source_status))missing.push('Booking status requires reconciliation');
  if(ownerPayout<0)missing.push('Negative owner entitlement requires review');
  // Owner/guest-paid costs need a later cash adjustment; never silently deduct twice.
  if(approved.some(e=>e.payer!=='bste'&&cents(e.owner_amount_cents)>0))missing.push('Owner deduction not yet funded by BSTE; reimbursement review required');
  if(approved.some(e=>cents(e.guest_amount_cents??0)>0))missing.push('Guest-recoverable amount requires collection review');
  const ownerRemaining=ownerState==='fully_settled'?0:Math.max(0,ownerPayout-cents(opening?.owner_settled_cents??0));
  const cleanerRemaining=cleanerState==='fully_settled'?0:Math.max(0,cleaner-cents(opening?.cleaner_settled_cents??0));
  if(cents(opening?.owner_settled_cents??0)>Math.max(0,ownerPayout)||cents(opening?.cleaner_settled_cents??0)>cleaner)missing.push('Opening payment exceeds current obligation; review required');
  let eligibility=missing.length?'needs_review':received<expectedFunds?'awaiting_funds':booking?.departure>today?'awaiting_checkout':'draft_ready';
  if(opening?.state==='fully_settled_historical')eligibility='historical_settled';
  return {...position,label:'Draft — not an approved statement or payment instruction',currency:'ZAR',
    accommodation_cents:accommodation,cleaning_charge_cents:cleaning,channel_fees_cents:fees,
    owner_gross_cents:ownerGross,stocking_cents:sum(approved.filter(e=>e.category==='stocking'),'owner_amount_cents'),
    laundry_cents:sum(approved.filter(e=>e.category==='laundry'),'owner_amount_cents'),
    other_owner_expenses_cents:sum(approved.filter(e=>!['stocking','laundry'].includes(e.category)),'owner_amount_cents'),
    cleaner_cost_cents:cleaner,owner_payout_cents:ownerPayout,owner_outstanding_cents:ownerRemaining,cleaner_outstanding_cents:cleanerRemaining,
    owner_payout_eligible:eligibility==='draft_ready'&&ownerState!=='fully_settled'&&ownerRemaining>0,
    accommodation_contribution_cents:accommodationContribution,cleaning_contribution_cents:cleaningContribution,
    stay_contribution_cents:accommodationContribution+cleaningContribution,
    other_bste_costs_cents:bsteCosts,contribution_after_other_costs_cents:accommodationContribution+cleaningContribution-bsteCosts,
    guest_recoverable_cents:sum(approved,'guest_amount_cents'),expected_funds_cents:expectedFunds,received_cents:received,
    funds_status:received>=expectedFunds?'received_reviewed_amount':received?'part_received':'awaiting_funds',eligibility,missing,
    checkout_month:finance.checkout_month,exclude_from_new_payables:opening?.state==='fully_settled_historical',
    cleaner_monthly_candidate_cents:opening?.state==='fully_settled_historical'?0:cleanerRemaining};
}
export function validateReceipt(bytes, type) {
  if(!bytes.length||bytes.length>2097152)throw new Error('Receipt must be 1 byte to 2 MiB');
  const valid=type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
    type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    type==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':false;
  if(!valid)throw new Error('Receipt must be a matching JPG, PNG or PDF file');
}
