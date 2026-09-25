# Opening write compatibility correction

240003 replaces the old installed ops_finance_write(text,jsonb) while leaving all
applied migrations unchanged. Local 230001 already contained the five-field write;
staging still had its older branch. The new migration carries forward the complete
current function with stronger opening validation. Other action branches are unchanged.

Opening actions support open/outstanding, explicit historical settlement and
append-only reopening/revisions. Omitted obligation states derive from requested
state; explicit states must agree. Both fully settled requires the historical
marker; open may include one settled party while the other is outstanding/partial.
Partial requires a known positive integer-cent amount. Outstanding requires zero.
Any prior settlement requires Bond confirmation. Admin/cutover authorization is
checked before even returning an idempotent opening retry. Existing request hashes,
booking locks, previous_id checks, audit triggers and RLS remain intact.

Five aligned fields are written explicitly. Two nullable boolean metadata columns
are added: owner_settled_amount_known and cleaner_settled_amount_known. Existing rows
are untouched (NULL = the previous writer did not record knowledge). New outstanding
rows record known zero; supplied amounts record known amounts; omitted full-settlement
amounts record false. Their existing NOT NULL cents field retains a zero storage
placeholder, explicitly NOT an assertion of zero money paid. No payment or funds
receipt is generated. No constraint is removed or weakened. The UI displays unknown
amounts blank and omits them from the request; explicit zero remains distinguishable.

The API forwards the input unchanged and needs no change. Old state-only SQL callers
remain supported: full settlement derives both fully-settled obligations and unknown
amount flags. Historical importer/repair functions remain untouched; their rows retain
NULL flags, and outstanding state still means zero settled. Finance amount display
was adjusted to prevent resubmitting an unknown historical amount as a known zero.

Apply 240003 only after separately authorized staging review; then rerun the entire
opening-period-correction-rls.sql and finance RLS tests. Its conflicting full-settlement
fixture still uses REAL ops_finance_write and should now reach the intended repair
conflict check. Expanded nested rollback fixtures test valid defaults, settlement,
unknown amounts, invalid states/amounts, retries, reopening, stale revisions and
no unrelated financial writes. No real repair/import should be run yet.

No migration or SQL regression was executed locally. PostgreSQL validation remains
required in staging. Replacing the full function also requires the existing current
finance schema for non-opening branches (including expenses_complete); their live
compatibility has not been independently verified in this local-only task.
