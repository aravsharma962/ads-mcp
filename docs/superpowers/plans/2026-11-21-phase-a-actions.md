# Phase A: Actions, Reports, Page Drop-offs, Retargeting Ideas, Lead Status

**Goal:** Read-only decision support per client: which ads to scale, refresh or pause (with reasons), a copy-winners list, a weekly report with a WhatsApp-ready text, page-wise drop-offs and 10-second bounces from the first-party tracker, contextual retargeting suggestions, and lead status for cost per qualified lead. No Meta write access.

**Spec:** Video "How to use Meta Ads MCP with Claude" (kill rule: frequency 3, CTR down >25%, cost per purchase up >15%; copy winners; weekly report; landing pages with bounce under 10 s; contextual retargeting after page drop-offs) and the user's whiteboard screenshots. Contract: `web/src/lib/actions/types.ts` (already committed; do not change shapes without telling the controller).

## Global Constraints
- UI and messages in English. TypeScript in `/web`, Python only in the hub (`/src`). Tests: `cd web && npx vitest run`, hub tests `python tests/test_*.py` print ALL TESTS PASSED.
- `.gitignore` ignores `lib/`: always `git add -f` files under `web/src/lib`.
- No personal data in tracker events (existing rule). Tenant isolation via RLS and `getOwnedClient` for every new route.
- Never fabricate numbers: no data means null and "Not enough data", not 0.
- Verdicts are suggestions only. Nothing is written to Meta.
- Business result per type: ecommerce = purchases, lead_gen = leads, saas_b2b = signups (the effective counts already on `PerfRow`).

## Review Focus
- Previous window with zero data (new ad): must not be reported as a CTR drop or cost rise.
- Results = 0 with spend > 0 in the recent window after results in the previous window counts as a cost rise.
- Division by zero everywhere: impressions 0, clicks 0, reach 0.
- Same session on several pages and several ads (first-touch ad id): counted once per page.
- Client with no site/tracker: pages and leads endpoints return a clear "tracking not set up" state, not an error.

## Tasks (parallel group 1: T1-T5; group 2: T6, T7; then T8)

### T1 Hub: frequency and reach
Files: `src/ads_api.py`, `src/performance.py`, `tests/test_insights.py`, `tests/test_performance.py`.
- Add `frequency,reach` to `INSIGHTS_FIELDS`; `parse_insights_row` returns `reach` (int) and `frequency` (float or None when reach is 0).
- `performance.SUM_FIELDS` gains `reach`; `sum_rows` recomputes `frequency = impressions / reach` (None when reach 0). Merged rows keep `reach` summed (documented approximation across accounts).
- Tests: parse with and without reach; merge across two accounts.

### T2 Migration 005
Files: `supabase/migrations/005_actions.sql`, `tests/test_migration_005.py` (same style as test_migration_004).
- `alter table clients add column if not exists action_rules jsonb not null default '{}'::jsonb;`
- `create table lead_marks (client_id uuid references clients(id) on delete cascade, session_id text not null, status text not null check (status in ('new','qualified','won','lost')), updated_at timestamptz not null default now(), primary key (client_id, session_id));` with RLS enabled and tenant policies copied from the style used for `targets` (select/insert/update for members of the client's tenant; no delete needed). Index on `events (client_id, name, ts desc)`.
- Test: file contains each statement, RLS enabled, policies exist.

### T3 Rules + verdict engine (pure)
Files: `web/src/lib/actions/rules.ts`, `web/src/lib/actions/verdicts.ts`, tests beside them; `web/src/lib/performance.ts` (+`frequency`, `reach` on `PerfRow`, parsed with `num`, `frequency` null when missing/0).
- `parseActionRules(raw: unknown): ActionRules` (defaults for missing/invalid keys, clamped: frequency_max 1-20, ctr_drop_pct 1-90, cost_rise_pct 1-500, min_impressions 100-1e6, min_results_scale 1-1000, scale_better_pct 1-90, window_days 3-30 integers, bounce_seconds 1-60).
- `computeActions(input: { type: BusinessType; recent: PerfRow[]; previous: PerfRow[]; rules: ActionRules; targets: Targets; currency: string }): AdAction[]` (ad level; rows matched by `ad_id`/`id`; worst verdict first, then spend desc).
  - results via `resultCount(row, type)`; `cost_per_result = spend / results` (null when results 0); `ctr = link_clicks / impressions * 100`.
  - `too_early`: recent impressions < min_impressions.
  - Signals: frequency >= frequency_max; ctr_drop when previous impressions >= min_impressions and ctr fell by more than ctr_drop_pct; cost_rise when previous results > 0 and (recent cost per result rose by more than cost_rise_pct, or recent results = 0 with recent spend > 0).
  - 3 signals = `pause`; 2 = `refresh_creative`; 1 = `keep_watch`; 0 = `scale` only when recent results >= min_results_scale and (a target exists and is met: cpl max / cost_per_trial max / roas min for the type, ecommerce uses roas when `purchase_value` > 0, else cost per result vs account average; or cost per result is at least scale_better_pct cheaper than the account average), else `keep_watch`.
  - `confidence`: high when recent impressions >= 10000 and results >= 10; medium when >= 3000 and >= 3; else low.
  - `reasons` contain real numbers, e.g. "Frequency 3.4 (limit 3)", "CTR fell 31% (1.2% vs 1.7%)". `suggestion` for scale: "Raise the budget by at most 20%, then wait 3 days before the next change."
- `pickWinners(actions: AdAction[], limit = 5): AdAction[]` = verdict scale, lowest cost per result first.
- `resultCount(row: PerfRow, type: BusinessType): number`, `resultLabel(type): string`.

### T4 Page analysis + tracker page_leave + collector
Files: `web/src/lib/actions/pages.ts` (+test), `web/src/tracker/tracker.ts` (+test), `web/src/app/api/collect/route.ts` (+test).
- Tracker: on `pagehide` (once per page load) send `page_leave` with `value` = whole seconds on page (cap 86400). Never breaks the page.
- Collector: `page_leave` is an accepted event; its value max 86400 (other limits unchanged); not a conversion.
- `type EventRow = { session_id: string; name: string; ad_id: string | null; url: string | null; value: number | null; ts: string }`.
- `analyzePages(events: EventRow[], conversionEvents: string[], bounceSeconds: number): { pages: PageStat[]; sessions: number; bounced_sessions: number }`: per page unique sessions with a page_view; exit = last page_view of a session that has no conversion event; bounce = session with exactly one distinct page_view url, a page_leave value < bounceSeconds and no conversion; sessions without page_leave are never bounces. Rates null when denominator 0. Sorted by sessions desc.
- `suggestRetargeting(events: EventRow[], conversionEvents: string[], adNames: Record<string, string>, limit = 5): RetargetSuggestion[]`: per (page url, ad id) count sessions that viewed the page and never converted; keep groups with at least 5 visitors; text like "12 visitors from ad "X" viewed /pricing and left without converting. Retarget them with a creative that answers price questions (offer, comparison, proof)." Wording by page keyword (price/pricing, trial, size, demo, product/other).

### T5 Report builder + lead stats (pure)
Files: `web/src/lib/actions/report.ts`, `web/src/lib/actions/leads.ts`, tests.
- `buildReport(input: { clientName: string; type: BusinessType; currency: string; windows: ReportResponse["windows"]; recentTotals: PerfTotals; previousTotals: PerfTotals; actions: AdAction[]; targets: Targets }): ReportResponse` including `target_checks` (reuse `statusFor`/labels from `lib/metrics.ts`), top 3 and bottom 3 ads by cost per result among ads with results/spend, `next_actions` from verdict counts (e.g. "Pause 2 ads", "Refresh creative on 1 ad", "Raise budget on 1 winner"), and `whatsapp_text`.
- `leadStats(leads: LeadRow[], spend: number): { total; qualified; won; cost_per_lead: number | null; cost_per_qualified_lead: number | null }` where qualified counts statuses qualified and won; null when the count is 0.

### T6 API layer (after T1-T5)
Files: `web/src/lib/actions/data.ts`, routes under `web/src/app/api/clients/[clientId]/`: `actions/route.ts`, `rules/route.ts`, `report/route.ts`, `pages/route.ts`, `leads/route.ts`, tests.
- `data.ts`: `fetchPerformance(a, client, range, level)` extracted from the existing performance route (that route then calls it; its tests stay green), `computeWindows(rules.window_days, today)`.
- `GET actions` -> `ActionsResponse`; `GET report` -> `ReportResponse`; `GET/PUT rules` (zod validated, saves `clients.action_rules`); `GET pages?from&to` -> `PagesResponse` (reads `events` through the user client, cap 20000 rows, `truncated`); `GET leads?from&to` -> `LeadsResponse`, `PUT leads {session_id, status}` upserts `lead_marks` (session must be a lead event of that client).
- All use `apiContext` + `getOwnedClient`; no tracker site -> `pages`/`leads` return 200 with `tracking: false` and empty lists (add `tracking: boolean` to those two responses).

### T7 UI (after T6 shapes; can start with the contract)
Files: pages under `web/src/app/(app)/clients/[clientId]/`: `actions/page.tsx`, `report/page.tsx`, `pages/page.tsx` (named "Site pages"), `leads/page.tsx`, components under `web/src/components/actions/`, nav entry in the client layout, rules editor on the Actions page.
- Actions: verdict summary chips, table of ads (thumbnail, verdict badge, confidence, reasons), Copy winners panel, "Edit rules" form.
- Report: cards + "Copy WhatsApp text" button + print-friendly layout.
- Site pages: table with exit and bounce rates, retargeting ideas. Leads: table with status select, cost per lead and cost per qualified lead.
- Empty states: no ad account, no tracker, not enough data.

### T8 Finish
Docs: add to `docs/deploy-saas.md` (migration 005 before deploy; tracker snippet must be re-copied only if the user wants bounce data: `t.js` is served by the app, so no snippet change). Full web tests, `npm run build`, hub tests, `git add -f web/src/lib`, commit, zip `phase-a.zip`.
