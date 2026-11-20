-- Per-client business type: decides which metrics (KPI cards, table, targets, assistant) a client uses.
-- Existing clients stay 'ecommerce'. Adding a column with a constant default is a metadata-only change.
alter table clients
  add column if not exists business_type text not null default 'ecommerce'
  check (business_type in ('lead_gen','saas_b2b','ecommerce'));
