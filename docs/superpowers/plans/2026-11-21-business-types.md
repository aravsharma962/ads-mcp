# Per-client Business Type Templates

Date: 2026-11-21. Builds on `docs/superpowers/specs/2026-11-20-saas-platform-design.md` and `docs/superpowers/plans/2026-11-20-saas-platform.md`. All UI text English.

## Goal

An agency picks a business type per client. The type decides which metrics the dashboard KPI cards, performance table, targets page, performance API and AI assistant show. Existing clients stay `ecommerce` and see no change.

## Decisions (binding)

1. `clients.business_type text not null default 'ecommerce' check in ('lead_gen','saas_b2b','ecommerce')`, new migration `supabase/migrations/004_business_types.sql` (001-003 untouched), plus a static test `tests/test_migration_004.py`.
2. Metric sets (all rates are recomputed from summed totals; `null` when the denominator is 0; never NaN/Infinity; direction-aware `statusFor` unchanged):
   - ecommerce: `ctr, cpc, cpm, visit_rate, add_to_cart_rate, conversion_rate, roas` (unchanged).
   - lead_gen: `ctr, cpc, cpm, cpl` (spend / leads, lower better), `lead_rate` (leads / link clicks %, higher better).
   - saas_b2b: `ctr, cpc, cpm, cpl` (cost per signup = spend / signups, lower better), `signup_rate` (signups / link clicks %), `demo_rate` (demo_booked sessions / link clicks %), `cost_per_trial` (spend / trial_start sessions, lower better), `cac` (spend / paid events, lower better).
3. Lead source. Meta leads = the `lead` action; if absent, `onsite_conversion.lead_grouped`. Never the sum: Meta reports on-Facebook instant-form leads under both action types, and `lead` is the superset, so adding them would double count. Tracked leads = unique sessions with a `lead` or `form_submit` event. Source follows the `roas_source` pattern: tracked when the client has a site, else Meta.
4. saas signups = unique sessions with a `signup` event when the client has a site, else the Meta lead count. Trials (`trial_start`), demos (`demo_booked`): unique sessions. Paid: count of `paid` events (not unique). `demo_rate`, `cost_per_trial`, `cac` need tracking and show "Tracking not set up" without a site.
5. Targets for new metrics start EMPTY (min and max null). With an empty band the status is `no_data` and the UI says "Set a target", never "Off target". Existing ecommerce defaults unchanged. The Targets page lists only the client type's metrics; a PUT for a metric outside the type is a 400.
6. Creating a client requires a type (select: "Lead Generation (clinics, real estate)", "SaaS / B2B Leads", "E-commerce"). The owner can change it later (`PATCH /api/clients/[id]`); target rows for newly relevant metrics are created on demand (never overwriting existing rows), and an existing site's `conversion_events` follows the new type.
7. Collector accepts the additional events `signup, trial_start, demo_booked, lead, paid` (existing ones kept, personal-data key rejection unchanged, value cap also applies to `paid`). `sites.conversion_events` default per type: ecommerce `{purchase,form_submit}`, lead_gen `{lead,form_submit}`, saas_b2b `{signup,demo_booked,paid}`. Tracking page lists the events per type with `adsTrack('signup')` style examples. The tracker script itself passes any event name through, so it needs no change.
8. Hub: `meta_ads_insights` rows gain `leads`; `sum_rows` sums it; `merge_performance` adds `signup_sessions, trial_sessions, demo_sessions, lead_sessions, paid_events` per row and the same keys under `unattributed`. Existing fields unchanged.
9. Web: `metrics.ts` gets `BusinessType`, per-type metric lists, `DIRECTION`/formatters for the new keys (cpl, cost_per_trial, cac as currency; rates as %), `metricsForType(type)`. Dashboard, PerformanceTable, performance route, targets, AI system prompt are all driven by the type. The type is only ever read from the tenant-checked client row (`getOwnedClient`); a missing value is treated as `ecommerce`.

## Tasks (strict TDD, one commit each, `feat: ...`)

1. Migration 004 + `tests/test_migration_004.py` (static: column, default, check list, no edits to 001-003).
2. Hub: `leads` in `parse_insights_row`/`sum_rows`; per-event session counts in `merge_performance`. Tests in `tests/test_insights.py`, `tests/test_performance.py` (lead vs lead_grouped no double count, unique sessions, paid counts events, unattributed, zero clicks).
3. Web metrics: types, definitions, `computeRates(totals, type)`, `statusFor` with empty bands, `metricsForType`, formatters. Tests in `metrics.test.ts` (zero denominators for every metric, direction, null targets).
4. Web performance normalisation: type and source aware (`performance.ts`). Tests: lead source tracked vs Meta, saas tracking-only metrics null without a site.
5. Collector: new events, PII still rejected, value cap for `paid`. Tests in `collect.test.ts`.
6. API: clients create requires a valid type and seeds the type's targets; PATCH type (owner only, tenant isolated); targets GET/PUT/reset by type; site POST conversion_events by type; performance route returns `business_type` and type-specific rates. Tests incl. type switching, other agency 404, member 403.
7. UI: NewClientForm select, BusinessTypeSelect on the Targets page, TargetsEditor/Dashboard/PerformanceTable/KpiCard driven by type, "Set a target" hint, Tracking page copy per type. Component tests.
8. AI system prompt: business type and which metrics matter; tool descriptions mention the new counts. Test in `chat.test.ts`.
9. Final: all Python tests, `npm test`, `npm run build`, `git archive`.

## Deferred

- Per-client `leads_source` override (instant-form leads are invisible to the tracker; for such clients the agency should not set up a site, or a setting is needed).
- `paid` event value (revenue/ROAS for SaaS) in the hub and dashboard.
- Per-type default targets beyond empty bands.
