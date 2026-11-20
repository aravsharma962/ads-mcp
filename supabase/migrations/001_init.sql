-- Solution B: multi-tenant schema (Supabase / Postgres)
-- Chalane ka tareeka: Supabase Dashboard -> SQL Editor -> paste -> Run.

create extension if not exists pgcrypto;

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

-- API key ka sirf hash store hota hai. Asli key sirf ek baar dikhai jaati hai.
create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  label       text,
  key_hash    text not null unique,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- Har client ka ad account. Token Fernet se encrypt hokar aata hai (plain text kabhi nahi).
create table ad_connections (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  platform      text not null check (platform in ('meta','google')),
  external_id   text not null,          -- act_123... ya Google customer id
  token_enc     text not null,          -- encrypted access token
  refresh_enc   text,                   -- encrypted refresh token (Google)
  scopes        text[],
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (tenant_id, platform, external_id)
);

create table audit_log (
  id            bigserial primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  actor         text,                   -- api key label
  tool          text not null,
  args_redacted jsonb,
  result        text not null,          -- ok / denied / error
  created_at    timestamptz not null default now()
);

create index on api_keys (tenant_id);
create index on ad_connections (tenant_id);
create index on audit_log (tenant_id, created_at desc);

-- Row Level Security: chalu, aur koi policy nahi.
-- Matlab anon/authenticated users in tables ko seedha nahi padh sakte.
-- Hamara server `service_role` key use karta hai, jo RLS bypass karti hai.
-- (Dashboard banate waqt hum per-tenant policies alag se jodenge.)
alter table tenants        enable row level security;
alter table api_keys       enable row level security;
alter table ad_connections enable row level security;
alter table audit_log      enable row level security;

-- Naye Supabase projects me service_role ko SQL-bani tables par auto access nahi milta.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
