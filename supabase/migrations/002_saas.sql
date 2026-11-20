-- SaaS schema (Phase 1a/1b): agency users, clients, targets, chat, usage, first-party tracking.
-- Chalane ka tareeka: Supabase Dashboard -> SQL Editor -> paste -> Run. (001_init.sql pehle chal chuki ho.)
-- Tenant = agency (tenants table, 001). Browser users (Supabase Auth) memberships se tenant se jude hain.

-- Auth user -> tenant. Ek user ek agency. Signup invite-only: rows owner/service role banata hai.
create table memberships (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null check (role in ('owner','member')),
  created_at  timestamptz not null default now()
);

-- Client = agency ka brand. Ek client = ek currency + ek timezone (uske saare ad accounts ke liye).
create table clients (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  currency     text not null,
  timezone     text not null,
  roas_source  text not null default 'tracking' check (roas_source in ('tracking','meta')),
  created_at   timestamptz not null default now()
);

create table client_accounts (
  client_id    uuid not null references clients(id) on delete cascade,
  platform     text not null check (platform in ('meta','google')),
  external_id  text not null,
  primary key (client_id, platform, external_id)
);

-- Per-client editable targets. min/max dono optional (CPC: sirf max, CTR: sirf min).
create table targets (
  client_id   uuid not null references clients(id) on delete cascade,
  metric      text not null,
  min_value   numeric,
  max_value   numeric,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  primary key (client_id, metric)
);

create table conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now()
);

create table messages (
  id               bigserial primary key,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null,
  content          jsonb not null,
  created_at       timestamptz not null default now()
);

-- AI token usage (monthly cap per tenant). Rows sirf server (service role) likhta hai.
create table usage_events (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  provider    text not null,
  tokens_in   int not null default 0,
  tokens_out  int not null default 0,
  created_at  timestamptz not null default now()
);

-- Server-side cache. Koi browser policy nahi: sirf service role.
create table insights_cache (
  key         text primary key,
  payload     jsonb not null,
  expires_at  timestamptz not null
);

-- First-party tracking: client ki website ka site key aur allowed origins.
create table sites (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete cascade,
  site_key           text not null unique,
  allowed_origins    text[] not null default '{}',
  conversion_events  text[] not null default '{purchase,form_submit}'
);

-- Tracker events. Raw IP kabhi store nahi hota. Sirf collector (service role) insert karta hai.
create table events (
  id           bigserial primary key,
  client_id    uuid not null references clients(id) on delete cascade,
  session_id   text not null,
  name         text not null,
  campaign_id  text,
  adset_id     text,
  ad_id        text,
  url          text,
  value        numeric,
  currency     text,
  ts           timestamptz not null default now()
);

create index on clients (tenant_id);
create index on conversations (tenant_id, client_id, created_at desc);
create index on messages (conversation_id, id);
create index on usage_events (tenant_id, created_at);
create index on insights_cache (expires_at);
create index on sites (client_id);
create index on events (client_id, ts desc);
create index on events (client_id, ad_id);

-- Row Level Security: sab tables par chalu.
alter table memberships     enable row level security;
alter table clients         enable row level security;
alter table client_accounts enable row level security;
alter table targets         enable row level security;
alter table conversations   enable row level security;
alter table messages        enable row level security;
alter table usage_events    enable row level security;
alter table insights_cache  enable row level security;
alter table sites           enable row level security;
alter table events          enable row level security;

-- Policies: sirf `authenticated` (logged-in agency users) ko. anon ko kuch nahi.
-- Members apni agency ki rows padhte hain; owner-only writes 'owner' role check karte hain.

-- memberships: sirf apni row
create policy memberships_select_own on memberships for select to authenticated
  using (user_id = auth.uid());

-- clients
create policy clients_select on clients for select to authenticated
  using (tenant_id in (select tenant_id from memberships where user_id = auth.uid()));
create policy clients_insert_owner on clients for insert to authenticated
  with check (tenant_id in (select tenant_id from memberships where user_id = auth.uid() and role = 'owner'));
create policy clients_update_owner on clients for update to authenticated
  using (tenant_id in (select tenant_id from memberships where user_id = auth.uid() and role = 'owner'))
  with check (tenant_id in (select tenant_id from memberships where user_id = auth.uid() and role = 'owner'));
create policy clients_delete_owner on clients for delete to authenticated
  using (tenant_id in (select tenant_id from memberships where user_id = auth.uid() and role = 'owner'));

-- client_accounts (client ke zariye tenant)
create policy client_accounts_select on client_accounts for select to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));
create policy client_accounts_insert_owner on client_accounts for insert to authenticated
  with check (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid() and role = 'owner')));
create policy client_accounts_delete_owner on client_accounts for delete to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid() and role = 'owner')));

-- targets: members bhi badal sakte hain
create policy targets_select on targets for select to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));
create policy targets_insert on targets for insert to authenticated
  with check (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));
create policy targets_update on targets for update to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())))
  with check (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));

-- conversations: agency ke members padhte hain; banate waqt user_id apna aur client apni agency ka
create policy conversations_select on conversations for select to authenticated
  using (tenant_id in (select tenant_id from memberships where user_id = auth.uid()));
create policy conversations_insert on conversations for insert to authenticated
  with check (user_id = auth.uid()
    and tenant_id in (select tenant_id from memberships where user_id = auth.uid())
    and client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));

-- messages (conversation ke zariye tenant)
create policy messages_select on messages for select to authenticated
  using (conversation_id in (select id from conversations where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));
create policy messages_insert on messages for insert to authenticated
  with check (conversation_id in (select id from conversations where user_id = auth.uid()
        and tenant_id in (select tenant_id from memberships where user_id = auth.uid())));

-- usage_events: sirf padhna (likhta service role)
create policy usage_events_select on usage_events for select to authenticated
  using (tenant_id in (select tenant_id from memberships where user_id = auth.uid()));

-- sites: members padhte hain, sirf owner banata/hatata hai
create policy sites_select on sites for select to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));
create policy sites_insert_owner on sites for insert to authenticated
  with check (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid() and role = 'owner')));
create policy sites_update_owner on sites for update to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid() and role = 'owner')))
  with check (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid() and role = 'owner')));
create policy sites_delete_owner on sites for delete to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid() and role = 'owner')));

-- events: sirf padhna. Insert/update/delete ke liye koi policy nahi: sirf service role (collector).
create policy events_select on events for select to authenticated
  using (client_id in (select id from clients where tenant_id in
        (select tenant_id from memberships where user_id = auth.uid())));

-- Table privileges. (RLS inke upar filter karti hai; anon ko kuch nahi diya.)
grant usage on schema public to authenticated;
grant select on memberships, clients, client_accounts, targets, conversations, messages,
                usage_events, sites, events to authenticated;
grant insert, update, delete on clients, sites to authenticated;
grant insert, delete on client_accounts to authenticated;
grant insert, update on targets to authenticated;
grant insert on conversations, messages to authenticated;
grant usage, select on sequence messages_id_seq to authenticated;

-- Naye tables par service_role access (001 ki default privileges purane tables ke baad bane tables ko cover
-- nahi karti agar woh 001 se pehle chali hon, isliye dobara explicitly).
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
