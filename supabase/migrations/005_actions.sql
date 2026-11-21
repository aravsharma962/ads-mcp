-- Phase A actions: per-client action rules, lead status marks, and an index for event-name lookups.
-- Idempotent: safe to run more than once.
alter table clients
  add column if not exists action_rules jsonb not null default '{}'::jsonb;

-- Agency's own status mark per tracked lead session (new / qualified / won / lost).
create table if not exists lead_marks (
  client_id   uuid not null references clients(id) on delete cascade,
  session_id  text not null,
  status      text not null check (status in ('new','qualified','won','lost')),
  updated_at  timestamptz not null default now(),
  primary key (client_id, session_id)
);

alter table lead_marks enable row level security;

-- Same tenant scoping as targets: members of the client's tenant only. No delete policy.
drop policy if exists lead_marks_select on lead_marks;
create policy lead_marks_select on lead_marks for select to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));

drop policy if exists lead_marks_insert on lead_marks;
create policy lead_marks_insert on lead_marks for insert to authenticated
  with check (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));

drop policy if exists lead_marks_update on lead_marks;
create policy lead_marks_update on lead_marks for update to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())))
  with check (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));

grant select, insert, update on lead_marks to authenticated;
grant select, insert, update, delete on lead_marks to service_role;

create index if not exists events_client_name_ts_idx on events (client_id, name, ts desc);
