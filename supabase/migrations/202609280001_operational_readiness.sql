-- OPS-1: additive staging-only review. DO NOT APPLY during local implementation.
-- No delivery transport, finance mutation, reservation update or external calls.
begin;
create table public.ops_readiness_templates (
 checkpoint_key text primary key,
 version integer not null default 1 check(version>0),
 label text not null,
 anchor text not null check(anchor in ('arrival','departure')),
 offset_days integer not null check(offset_days between -30 and 7),
 local_hour integer not null check(local_hour between 0 and 23),
 questions jsonb not null check(jsonb_typeof(questions)='array')
);
insert into public.ops_readiness_templates(checkpoint_key,label,anchor,offset_days,local_hour,questions) values
 ('pre_arrival','Pre-arrival readiness','arrival',-3,8,'["Pre-clean completed","Fresh linen/towels ready","Stocking/welcome items completed","Property inspection completed","No maintenance issue requiring attention"]'),
 ('final_arrival','Final arrival check','arrival',-1,8,'["Property ready for guest","Welcome provisions ready","Access/alarm checked","No unresolved issue"]'),
 ('arrival_day','Arrival-day readiness','arrival',0,8,'["Property ready for check-in"]'),
 ('departure','Departure check','departure',0,8,'["Guest checkout confirmed","No damage/problem requiring action","Cleaning proceeding as planned"]'),
 ('post_clean','Post-clean check','departure',0,16,'["Cleaning completed","Laundry handled as applicable","Replenishment/stocking expenses noted for separate finance entry","No maintenance issue requiring attention"]');
create table public.ops_readiness_checkpoints (
 id uuid primary key default gen_random_uuid(), booking_id uuid not null references public.ops_bookings(id),
 checkpoint_key text not null references public.ops_readiness_templates(checkpoint_key),
 template_version integer not null, label text not null,
 source_property_slug text not null references public.ops_properties(property_slug),
 source_arrival date not null, source_departure date not null, due_at timestamptz not null,
 status text not null default 'pending' check(status in ('pending','complete','needs_attention','deferred','not_applicable')),
 items jsonb not null check(jsonb_typeof(items)='array'),
 deferred_until timestamptz, schedule_review boolean not null default false,
 issue_open boolean not null default false, source_eligible boolean not null,
 historical_skip boolean not null default false, -- never-actionable past window, not unresolved work
 note text not null default '', revision integer not null default 1,
 responded_by uuid references public.ops_staff(user_id), responded_at timestamptz,
 response_source text check(response_source in ('dashboard_simulation')),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(booking_id,checkpoint_key,template_version),
 check ((status='deferred')=(deferred_until is not null))
);
create table public.ops_readiness_responses (
 id uuid primary key default gen_random_uuid(), checkpoint_id uuid not null references public.ops_readiness_checkpoints(id),
 booking_id uuid not null references public.ops_bookings(id),
 action text not null check(action in ('yes','no','tomorrow')),
 note text not null check(length(note)<=2000), actor uuid not null references public.ops_staff(user_id),
 response_source text not null check(response_source='dashboard_simulation'),
 before_state jsonb not null, after_state jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.ops_readiness_prompts (
 id uuid primary key, checkpoint_id uuid not null references public.ops_readiness_checkpoints(id),
 revision integer not null, actor uuid not null references public.ops_staff(user_id), session_id text not null,
 environment text not null check(environment='staging'), cycle integer not null check(cycle>0),
 created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
 superseded_at timestamptz,
 unique(checkpoint_id,revision,actor,session_id,environment,cycle)
);
create unique index ops_readiness_one_active_prompt on public.ops_readiness_prompts(checkpoint_id,revision,actor,session_id,environment) where superseded_at is null;
create table public.ops_readiness_actions (
 token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'),
 prompt_id uuid not null references public.ops_readiness_prompts(id),
 environment text not null default 'staging' check(environment='staging'),
 checkpoint_id uuid not null references public.ops_readiness_checkpoints(id), revision integer not null,
 actor uuid not null references public.ops_staff(user_id), session_id text not null,
 action text not null check(action in ('yes','no','tomorrow')),
 expires_at timestamptz not null, consumed_at timestamptz, result jsonb,
 unique(prompt_id,action), check((consumed_at is null)=(result is null))
);
create table public.ops_readiness_cleaning (
 booking_id uuid primary key references public.ops_bookings(id),
 state text not null check(state in ('assigned','not_required','unassigned')),
 cleaner_name text check(length(trim(cleaner_name)) between 1 and 120), expected_cleaning_at timestamptz check(isfinite(expected_cleaning_at)),
 source_arrival date not null, source_departure date not null, source_property_slug text not null,
 schedule_review boolean not null default false,
 check((state='assigned' and cleaner_name is not null) or (state<>'assigned' and cleaner_name is null and expected_cleaning_at is null)),
 note text not null check(length(note)<=2000), updated_by uuid not null references public.ops_staff(user_id),
 updated_at timestamptz not null default clock_timestamp()
);
create index ops_readiness_due on public.ops_readiness_checkpoints(due_at,booking_id);
create index ops_readiness_history on public.ops_readiness_responses(checkpoint_id,created_at);
-- Existing ops_tasks remain ad-hoc jobs; these versioned checkpoint aggregates are separate.
-- Audit captures every item/date/assignment revision without putting token hashes into ops_events.
do $$ declare t text; begin
 foreach t in array array['ops_readiness_templates','ops_readiness_checkpoints','ops_readiness_responses','ops_readiness_actions','ops_readiness_prompts','ops_readiness_cleaning'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach t in array array['ops_readiness_checkpoints','ops_readiness_responses','ops_readiness_cleaning'] loop
  execute format('create trigger audit_change after insert or update on public.%I for each row execute function public.ops_audit_change()',t);
 end loop;
end $$;
create trigger immutable before update or delete on public.ops_readiness_responses for each row execute function public.ops_no_change();
-- No direct application table grants/policies: only the scoped RPCs below.

create function public.ops_readiness_eligible(target_booking uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ops_bookings b
 left join lateral (select operational_status from public.ops_booking_overrides where booking_id=b.id order by created_at desc,id desc limit 1) o on true
 where b.id=target_booking and b.source_environment='production'
 and lower(b.source_status) not in ('cancelled','canceled','black','blocked')
 and coalesce(o.operational_status,'')<>'review_required'
 and (lower(b.source_status) in ('new','confirmed') or o.operational_status in ('confirmed','checked_in','checked_out')));
$$;
create function public.ops_readiness_outstanding(target_booking uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ops_readiness_checkpoints c join public.ops_bookings b on b.id=c.booking_id
 where b.id=target_booking and (c.issue_open or c.schedule_review or c.status in ('needs_attention','deferred')
 or (c.status='pending' and (c.due_at<=now() or (c.checkpoint_key='post_clean' and b.departure<(now() at time zone 'Africa/Johannesburg')::date)))))
 or exists(select 1 from public.ops_readiness_cleaning where booking_id=target_booking and schedule_review);
$$;
create function public.ops_readiness_supersede() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.revision<>old.revision then
  update public.ops_readiness_prompts set superseded_at=clock_timestamp() where checkpoint_id=new.id and superseded_at is null and revision<>new.revision;
 end if;
 return new;
end $$;
create trigger supersede_actions after update on public.ops_readiness_checkpoints for each row execute function public.ops_readiness_supersede();
create function public.ops_readiness_reconcile(target_booking uuid) returns void
language plpgsql security definer set search_path='' as $$
declare b public.ops_bookings; t public.ops_readiness_templates; c public.ops_readiness_checkpoints; cleaning public.ops_readiness_cleaning;
 due_time timestamptz; questions jsonb; eligible boolean; blocked boolean; next_status text; dirty boolean; exempt boolean;
begin
 select * into b from public.ops_bookings where id=target_booking for update;
 if not found or b.source_environment<>'production' then return; end if;
 eligible:=public.ops_readiness_eligible(b.id);
 blocked:=lower(b.source_status) in ('cancelled','canceled','black','blocked');
 -- Preserve the last explicitly confirmed arrangement dates/time. Flag once;
 -- repeated source refreshes must not create audit noise or erase that warning.
 update public.ops_readiness_cleaning set schedule_review=true,updated_at=clock_timestamp()
 where booking_id=b.id and not schedule_review and (source_arrival<>b.arrival or source_departure<>b.departure or source_property_slug<>b.property_slug);
 select * into cleaning from public.ops_readiness_cleaning where booking_id=b.id;
 for t in select * from public.ops_readiness_templates loop
  due_time:=(((case when t.anchor='arrival' then b.arrival else b.departure end)+t.offset_days)::timestamp+make_interval(hours=>t.local_hour)) at time zone 'Africa/Johannesburg';
  if t.checkpoint_key='post_clean' then due_time:=coalesce(cleaning.expected_cleaning_at,due_time); end if;
  exempt:=coalesce(t.checkpoint_key='post_clean' and cleaning.state='not_required' and not cleaning.schedule_review,false);
  select * into c from public.ops_readiness_checkpoints where booking_id=b.id and checkpoint_key=t.checkpoint_key and template_version=t.version for update;
  if not found then
   next_status:=case when not eligible or exempt or (due_time at time zone 'Africa/Johannesburg')::date<(now() at time zone 'Africa/Johannesburg')::date then 'not_applicable' else 'pending' end;
   select jsonb_agg(jsonb_build_object('key',t.checkpoint_key||':'||n,'label',q,'status',next_status)) into questions from jsonb_array_elements_text(t.questions) with ordinality x(q,n);
   insert into public.ops_readiness_checkpoints(booking_id,checkpoint_key,template_version,label,source_property_slug,source_arrival,source_departure,due_at,status,items,source_eligible,historical_skip,note)
    values(b.id,t.checkpoint_key,t.version,t.label,b.property_slug,b.arrival,b.departure,due_time,next_status,questions,eligible,
     next_status='not_applicable' and (due_time at time zone 'Africa/Johannesburg')::date<(now() at time zone 'Africa/Johannesburg')::date,
     case when not eligible then 'Source requires operational review; no prompts enabled' when exempt then 'Cleaning explicitly not required' when next_status='not_applicable' then 'Window passed before checklist enrollment; no retrospective prompt' else '' end);
   continue;
  end if;
  dirty:=c.source_property_slug<>b.property_slug or c.source_arrival<>b.arrival or c.source_departure<>b.departure or c.due_at<>due_time;
  if blocked then
   if c.source_eligible<>eligible or c.status not in ('complete','not_applicable') then
    update public.ops_readiness_checkpoints set source_eligible=false,
     status=case when c.status='complete' then 'complete' else 'not_applicable' end,
     items=case when c.status='complete' then c.items else (select jsonb_agg(i||jsonb_build_object('status','not_applicable')) from jsonb_array_elements(c.items) v(i)) end,
     deferred_until=null,revision=revision+1,updated_at=clock_timestamp() where id=c.id;
   end if;
   continue;
  end if;
  if not eligible then
   if c.source_eligible or not c.schedule_review then
    update public.ops_readiness_checkpoints set source_eligible=false,schedule_review=true,revision=revision+1,updated_at=clock_timestamp() where id=c.id;
   end if;
   continue;
  end if;
  next_status:=c.status;
  if exempt and not c.issue_open and not c.schedule_review and c.status<>'complete' then next_status:='not_applicable';
  elsif c.status='not_applicable' and (dirty or c.note like 'Source%' or c.note='Cleaning explicitly not required')
   and (not c.historical_skip or c.issue_open or (due_time at time zone 'Africa/Johannesburg')::date >= (now() at time zone 'Africa/Johannesburg')::date) then
   next_status:=case when c.issue_open then 'needs_attention' else 'pending' end;
  end if;
  if dirty or not c.source_eligible or next_status<>c.status or (t.checkpoint_key='post_clean' and coalesce(cleaning.schedule_review,false) and not c.schedule_review) then
   update public.ops_readiness_checkpoints set source_eligible=true,source_property_slug=b.property_slug,source_arrival=b.arrival,source_departure=b.departure,
    due_at=due_time,status=next_status,
    historical_skip=c.historical_skip and next_status='not_applicable',
    schedule_review=c.schedule_review or (dirty and not (c.historical_skip and next_status='not_applicable' and not c.issue_open) and (c.issue_open or c.status in ('complete','needs_attention','deferred') or due_time<now() or c.source_property_slug<>b.property_slug)) or coalesce(t.checkpoint_key='post_clean' and cleaning.schedule_review,false),
    -- A reschedule never resets a NO or deferral. Only an authorized YES clears issues/review.
    deferred_until=case when next_status='deferred' then c.deferred_until else null end,
    items=case when next_status=c.status then c.items else (select jsonb_agg(i||jsonb_build_object('status',next_status)) from jsonb_array_elements(c.items) v(i)) end,
    note=case when exempt and next_status='not_applicable' then 'Cleaning explicitly not required' else c.note end,
    revision=revision+1,updated_at=clock_timestamp() where id=c.id;
  end if;
 end loop;
end $$;
create function public.ops_readiness_source_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if TG_TABLE_NAME='ops_bookings' then
  if TG_OP='UPDATE' and new.arrival=old.arrival and new.departure=old.departure and new.source_status=old.source_status and new.property_slug=old.property_slug then return new; end if;
  perform public.ops_readiness_reconcile(new.id);
 else perform public.ops_readiness_reconcile(new.booking_id); end if;
 return new;
end $$;
create trigger readiness_source after insert or update on public.ops_bookings for each row execute function public.ops_readiness_source_changed();
create trigger readiness_review after insert on public.ops_booking_overrides for each row execute function public.ops_readiness_source_changed();
create function public.ops_readiness_generate(target_booking uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not public.ops_can('operations.write') then raise exception 'Operational permission required'; end if;
 if not exists(select 1 from public.ops_bookings where id=target_booking and source_environment='production') then raise exception 'Booking unavailable'; end if;
 perform public.ops_readiness_reconcile(target_booking);return jsonb_build_object('generated',true);
end $$;
create function public.ops_readiness_read(account_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not public.ops_can('operations.read') then raise exception 'Operational permission required'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
 'booking',jsonb_build_object('id',b.id,'property_slug',b.property_slug,'guest_name',b.guest_name,'guest_email',b.guest_email,'guest_mobile',b.guest_mobile,
 'source_kind',b.source_kind,'source_status',b.source_status,'source_channel',b.source_channel,'arrival',b.arrival,'departure',b.departure,
 'readiness_eligible',public.ops_readiness_eligible(b.id),
 'operational_status',(select operational_status from public.ops_booking_overrides where booking_id=b.id order by created_at desc,id desc limit 1)),
 'checkpoints',(select coalesce(jsonb_agg(to_jsonb(c) order by c.due_at),'[]') from public.ops_readiness_checkpoints c where c.booking_id=b.id),
 'cleaning',(select to_jsonb(a) from public.ops_readiness_cleaning a where a.booking_id=b.id),
 'communications',(select coalesce(jsonb_agg(jsonb_build_object('message_key',m.message_key,'route',m.route,'status',m.status,'scheduled_at',m.scheduled_at)),'[]') from public.ops_communications m where m.booking_id=b.id),
 'history',(select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc),'[]') from public.ops_readiness_responses r where r.booking_id=b.id)
 ) order by b.arrival,b.id),'[]') from public.ops_bookings b where b.source_environment='production'
 and (b.source_account=account_key or (b.source_kind='manual_direct' and b.source_account='bste-historical-direct'))
 and ((b.departure>=(now() at time zone 'Africa/Johannesburg')::date-7 and b.arrival<=(now() at time zone 'Africa/Johannesburg')::date+30) or public.ops_readiness_outstanding(b.id)));
end $$;
-- Private read-only snapshot: consumed replay MUST NOT call reconciliation or write anything.
create function public.ops_readiness_current(target_checkpoint uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('checkpoint',to_jsonb(c),'eligible',public.ops_readiness_eligible(b.id),
 'outstanding',public.ops_readiness_outstanding(b.id),'cleaning_review',coalesce((select schedule_review from public.ops_readiness_cleaning where booking_id=b.id),false),
 'booking',jsonb_build_object('id',b.id,'guest_name',b.guest_name,'arrival',b.arrival,'departure',b.departure,'source_status',b.source_status,'readiness_eligible',public.ops_readiness_eligible(b.id)),
 'property_name',(select display_name from public.ops_properties where property_slug=b.property_slug))
 from public.ops_readiness_checkpoints c join public.ops_bookings b on b.id=c.booking_id where c.id=target_checkpoint;
$$;
create function public.ops_readiness_prompt(target_checkpoint uuid,expected_revision integer,request_id uuid,token_hashes jsonb,replace_prompt uuid default null,target_environment text default 'staging') returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ops_readiness_checkpoints; p public.ops_readiness_prompts; a text; sess text:=auth.jwt()->>'session_id'; next_cycle integer;
begin
 if not public.ops_can('operations.write') or sess is null then raise exception 'Operational session required'; end if;
 if target_environment is distinct from 'staging' then raise exception 'Environment mismatch'; end if;
 select * into c from public.ops_readiness_checkpoints where id=target_checkpoint;
 if not found then raise exception 'Checkpoint unavailable'; end if;
 perform public.ops_readiness_reconcile(c.booking_id);
 select * into c from public.ops_readiness_checkpoints where id=target_checkpoint for update;
 if c.revision is distinct from expected_revision then raise exception 'Checkpoint changed; reload saved readiness'; end if;
 if not public.ops_readiness_eligible(c.booking_id) or c.status='not_applicable' then raise exception 'Checkpoint not applicable'; end if;
 if request_id is null then raise exception 'Prompt request identity required'; end if;
 select * into p from public.ops_readiness_prompts where id=request_id;
 if found then
  if p.checkpoint_id<>c.id or p.revision<>c.revision or p.actor<>auth.uid() or p.session_id<>sess or p.environment<>target_environment then raise exception 'Prompt identity conflict'; end if;
 end if;
 -- Ordinary preview resolves the CURRENT active generation, even if request_id
 -- names a superseded historical generation. Explicit request retries retain identity.
 if replace_prompt is null or p.id is null then
  select * into p from public.ops_readiness_prompts where checkpoint_id=c.id and revision=c.revision and actor=auth.uid() and session_id=sess and environment=target_environment and superseded_at is null;
  if replace_prompt is not null then
   if p.id is distinct from replace_prompt then raise exception 'Replacement prompt changed; reload'; end if;
   update public.ops_readiness_prompts set superseded_at=clock_timestamp() where id=p.id;
   p.id:=null;
  end if;
  if p.id is null then
   if jsonb_typeof(token_hashes) is distinct from 'object' or (select count(*) from jsonb_object_keys(token_hashes))<>3 then raise exception 'Invalid action tokens'; end if;
   select coalesce(max(cycle),0)+1 into next_cycle from public.ops_readiness_prompts where checkpoint_id=c.id and revision=c.revision and actor=auth.uid() and session_id=sess and environment=target_environment;
   insert into public.ops_readiness_prompts(id,checkpoint_id,revision,actor,session_id,environment,cycle,expires_at)
    values(request_id,c.id,c.revision,auth.uid(),sess,target_environment,next_cycle,clock_timestamp()+interval '10 minutes') returning * into p;
   foreach a in array array['yes','no','tomorrow'] loop
    if coalesce(token_hashes->>a,'') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid action tokens'; end if;
    insert into public.ops_readiness_actions(token_hash,prompt_id,checkpoint_id,revision,actor,session_id,environment,action,expires_at)
     values(token_hashes->>a,p.id,c.id,c.revision,auth.uid(),sess,target_environment,a,p.expires_at);
   end loop;
  end if;
 end if;
 return public.ops_readiness_current(c.id)||jsonb_build_object('prompt_id',p.id,'cycle',p.cycle,'expires_at',p.expires_at,'superseded',p.superseded_at is not null,
 'token_hashes',(select jsonb_object_agg(action,token_hash) from public.ops_readiness_actions where prompt_id=p.id),'preview_only',true,'sent',false);
end $$;
create function public.ops_readiness_respond(token_digest text,response_note text,expected_booking uuid,target_environment text default 'staging') returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ops_readiness_actions; p public.ops_readiness_prompts; c public.ops_readiness_checkpoints; before_value jsonb; result_value jsonb; next_status text; deferred timestamptz; questions jsonb; response_id uuid;
begin
 if not public.ops_can('operations.write') then raise exception 'Operational permission required'; end if;
 if target_environment is distinct from 'staging' then raise exception 'Environment mismatch'; end if;
 select * into a from public.ops_readiness_actions where token_hash=token_digest;
 if not found or a.actor<>auth.uid() or a.session_id is distinct from auth.jwt()->>'session_id' or a.environment<>target_environment then raise exception 'Action unavailable'; end if;
 select * into c from public.ops_readiness_checkpoints where id=a.checkpoint_id;
 if c.booking_id is distinct from expected_booking then raise exception 'Booking mismatch'; end if;
 -- Consistent book -> checkpoint -> action lock order, with NO reconciliation on replay.
 perform 1 from public.ops_bookings where id=c.booking_id for update;
 select * into c from public.ops_readiness_checkpoints where id=a.checkpoint_id for update;
 select * into a from public.ops_readiness_actions where token_hash=token_digest for update;
 if a.consumed_at is not null then
  return public.ops_readiness_current(c.id)||jsonb_build_object('saved',true,'replayed',true,'original_response',a.result,'sent',false);
 end if;
 perform public.ops_readiness_reconcile(c.booking_id);
 select * into c from public.ops_readiness_checkpoints where id=a.checkpoint_id;
 select * into p from public.ops_readiness_prompts where id=a.prompt_id;
 if not public.ops_readiness_eligible(c.booking_id) then raise exception 'Booking no longer eligible'; end if;
 if p.superseded_at is not null or a.expires_at<=clock_timestamp() or a.revision<>c.revision or c.status='not_applicable' then raise exception 'Action expired or checklist changed; reload preview'; end if;
 if response_note is null or length(response_note)>2000 then raise exception 'Invalid note'; end if;
 before_value:=to_jsonb(c);
 next_status:=case a.action when 'yes' then 'complete' when 'no' then 'needs_attention' else 'deferred' end;
 if a.action='tomorrow' then deferred:=(((now() at time zone 'Africa/Johannesburg')::date+1)::timestamp+interval '8 hours') at time zone 'Africa/Johannesburg'; end if;
 select jsonb_agg(item||jsonb_build_object('status',next_status,'response',a.action,'responded_by',auth.uid(),'responded_at',clock_timestamp(),'response_source','dashboard_simulation','note',response_note)) into questions from jsonb_array_elements(c.items) v(item);
 update public.ops_readiness_checkpoints set status=next_status,items=questions,deferred_until=deferred,
  issue_open=case a.action when 'yes' then false when 'no' then true else issue_open end,
  schedule_review=case when a.action='yes' then false else schedule_review end,
  responded_by=auth.uid(),responded_at=clock_timestamp(),response_source='dashboard_simulation',note=response_note,revision=revision+1,updated_at=clock_timestamp()
  where id=c.id returning * into c;
 insert into public.ops_readiness_responses(checkpoint_id,booking_id,action,note,actor,response_source,before_state,after_state)
  values(c.id,c.booking_id,a.action,response_note,auth.uid(),'dashboard_simulation',before_value,to_jsonb(c)) returning id into response_id;
 -- Cached receipt is minimal. Operational notes remain protected personal data in history.
 result_value:=jsonb_build_object('response_id',response_id,'action',a.action,'revision',c.revision);
 update public.ops_readiness_actions set consumed_at=clock_timestamp(),result=result_value where token_hash=token_digest;
 return public.ops_readiness_current(c.id)||jsonb_build_object('saved',true,'replayed',false,'sent',false);
end $$;
create function public.ops_readiness_cleaner(target_booking uuid,cleaning_state text,cleaner text,expected text,arrangement_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.ops_bookings; expected_time timestamptz;
begin
 if not public.ops_can('operations.write') then raise exception 'Operational permission required'; end if;
 select * into b from public.ops_bookings where id=target_booking and source_environment='production' for update;
 if not found then raise exception 'Booking unavailable'; end if;
 if cleaning_state is null or cleaning_state not in ('assigned','not_required','unassigned') or arrangement_note is null or length(arrangement_note)>2000 then raise exception 'Invalid cleaning arrangement'; end if;
 if cleaning_state='assigned' then
  if cleaner is null or length(trim(cleaner)) not between 1 and 120 then raise exception 'Assigned cleaner name required'; end if;
 else
  if cleaner is not null or expected is not null then raise exception 'Unassigned/not-required cleaning cannot include a cleaner or time'; end if;
  if cleaning_state='not_required' and length(trim(arrangement_note))=0 then raise exception 'Reason for cleaning exemption required'; end if;
 end if;
 if expected is not null then
  if expected !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Finite timestamp with explicit timezone required'; end if;
  expected_time:=expected::timestamptz;
  if not isfinite(expected_time) or (expected_time at time zone 'Africa/Johannesburg')::date<b.departure then raise exception 'Cleaning completion cannot precede departure'; end if;
 end if;
 insert into public.ops_readiness_cleaning(booking_id,state,cleaner_name,expected_cleaning_at,note,source_arrival,source_departure,source_property_slug,updated_by)
 values(b.id,cleaning_state,case when cleaning_state='assigned' then trim(cleaner) end,expected_time,arrangement_note,b.arrival,b.departure,b.property_slug,auth.uid())
 on conflict(booking_id) do update set state=excluded.state,cleaner_name=excluded.cleaner_name,expected_cleaning_at=excluded.expected_cleaning_at,note=excluded.note,
 source_arrival=excluded.source_arrival,source_departure=excluded.source_departure,source_property_slug=excluded.source_property_slug,schedule_review=false,updated_by=auth.uid(),updated_at=clock_timestamp();
 perform public.ops_readiness_reconcile(b.id);return jsonb_build_object('saved',true);
end $$;
revoke all on function public.ops_readiness_eligible(uuid),public.ops_readiness_outstanding(uuid),public.ops_readiness_supersede(),public.ops_readiness_reconcile(uuid),public.ops_readiness_source_changed(),public.ops_readiness_current(uuid),public.ops_readiness_generate(uuid),public.ops_readiness_read(text),public.ops_readiness_prompt(uuid,integer,uuid,jsonb,uuid,text),public.ops_readiness_respond(text,text,uuid,text),public.ops_readiness_cleaner(uuid,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.ops_readiness_generate(uuid),public.ops_readiness_read(text),public.ops_readiness_prompt(uuid,integer,uuid,jsonb,uuid,text),public.ops_readiness_respond(text,text,uuid,text),public.ops_readiness_cleaner(uuid,text,text,text,text) to authenticated;
commit;
