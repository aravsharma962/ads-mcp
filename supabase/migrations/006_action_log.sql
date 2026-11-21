-- Phase 2a apply: audit log of changes made in Meta from the app (pause / scale / resume).
-- Idempotent: safe to run more than once.
create table if not exists action_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  user_id     uuid,
  ad_id       text not null,
  ad_name     text,
  action      text check (action in ('pause','scale','resume')),
  level       text check (level in ('ad','adset','campaign')),
  object_id   text not null,
  before      jsonb not null default '{}'::jsonb,
  after       jsonb not null default '{}'::jsonb,
  status      text check (status in ('pending','ok','error','unknown')),
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists action_log_client_created_idx on action_log (client_id, created_at desc);

alter table action_log enable row level security;

-- Tenant isolation: members read only their own tenant's rows. No update/delete policies (append-only).
drop policy if exists action_log_select on action_log;
create policy action_log_select on action_log for select to authenticated
  using (tenant_id in (select tenant_id from memberships where user_id = auth.uid()));

-- No insert/update/delete policy for authenticated: members cannot write rows through PostgREST (that would let them
-- forge object_id/created_at/status and steer Resume and cooldowns). The web app writes with the service role,
-- after its own owner check. The old insert policy is dropped in case an earlier draft of this file was applied.
drop policy if exists action_log_insert on action_log;

-- At most one in-flight change per object: the atomic claim against double clicks and double raises.
create unique index if not exists action_log_pending_uq on action_log (client_id, object_id) where status = 'pending';

revoke insert, update, delete on action_log from authenticated;
grant select on action_log to authenticated;
grant select, insert, update, delete on action_log to service_role;
