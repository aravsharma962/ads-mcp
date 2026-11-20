# Ads Platform SaaS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1a + 1b of the SaaS: invite-only agency login, clients, targets, Meta dashboard, AI chat, and first-party tracking, on top of the existing Python MCP hub.

**Architecture:** Existing Python hub (Vercel project A, repo root) gains an internal REST API (service secret + tenant header), a new insights tool and an `ads_performance` tool. A new Next.js (TypeScript) app in `/web` (Vercel project B, root directory `web`) uses Supabase Auth, resolves the tenant from the verified session, and calls the hub server-to-server. Tracker script and collector live in the web app and write to Supabase.

**Tech Stack:** Python 3.12 + Starlette/FastMCP + supabase-py (hub); Next.js 15 App Router, TypeScript, Tailwind, `@supabase/ssr`, Vitest, Zod (web); Supabase Postgres + RLS; Anthropic and OpenAI SDKs.

**Spec:** `docs/superpowers/specs/2026-11-20-saas-platform-design.md`

## Global Constraints

- Existing hub behaviour and the six existing test files (`test_hosted`, `test_store_admin`, `test_admin_auth`, `test_admin_api`, `test_admin_page`, `test_store_resilience`) keep passing; Python hub is not rewritten.
- All UI text is English. Web app is TypeScript. No secret uses a `NEXT_PUBLIC_` prefix.
- Tenant identity comes from authentication only: web derives it from the verified Supabase session; the hub accepts `X-Tenant-Id` only together with a correct `X-Hub-Secret` and only on `/internal/*`. Never from browser input or tool arguments.
- MVP is read-only on Meta (`ads_read`), Meta API v27.0. Invite-only signup (open signup disabled). Roles: `owner`, `member`.
- Status model: `on target | better | off target | no data`; direction per metric (CTR, add-to-cart rate, conversion rate, website visit rate, ROAS higher is better; CPC, CPM lower is better).
- Definitions: CTR = link clicks / impressions; CPC = spend / link clicks; CPM = spend / impressions x 1000; website visit rate, add-to-cart rate, conversion rate = unique ad-attributed sessions with the event / link clicks; ROAS = tracked purchase value / spend (client setting `roas_source`: `tracking` or `meta`). Rates recomputed from summed totals, never averaged. Attribution window = ad account default.
- One client = one currency and one timezone across its ad accounts; mismatch rejected at connect.
- Default targets: CTR min 3; CPC max 20; CPM 13-14; add-to-cart rate 14-16; conversion rate 10-12; ROAS 9-12; website visit rate min 80.
- AI: default provider Claude, OpenAI adapter selectable by env `AI_PROVIDER`; model names from env `AI_MODEL_CLAUDE`, `AI_MODEL_OPENAI`; monthly cap 200000 tokens per tenant (`AI_MONTHLY_TOKEN_CAP`).
- Collector stores no raw IP and rejects personal-data fields; per-client allowed origins; tracker cookie lifetime 30 days.
- Python tests run as `python tests/<file>.py` printing `ALL TESTS PASSED`; web tests as `npm test` (Vitest) inside `/web`.

## Review Focus

- A second agency's logged-in user requests the first agency's client id, conversation id, or site key settings: must get not-found, never data. (Tasks 5, 10, 13)
- Hub `/internal/*` called with a correct tenant header but missing or wrong secret, or with secret but missing tenant: reject, and public routes ignore `X-Tenant-Id`. (Task 2)
- Meta returns no rows, zero impressions or zero clicks: rates are `null` (shown as "no data"), never NaN or Infinity. (Tasks 1, 4, 7)
- Chat when the monthly cap is reached, when the AI provider errors, or when a tool call fails: user sees a clear English message, no secret or stack trace. (Task 9)
- Collector gets events from a disallowed origin, with a personal-data field (`email`, `phone`, `name`), an oversized body, or an unknown site key: reject without storing. (Task 12)

---

## Shared contracts (all tasks use these exact names)

**Supabase migration `supabase/migrations/002_saas.sql`** (Task 3) creates: `memberships(user_id uuid pk -> auth.users, tenant_id uuid -> tenants, role text check in ('owner','member'), created_at)`, `clients(id uuid pk, tenant_id, name, currency text, timezone text, roas_source text default 'tracking', created_at)`, `client_accounts(client_id uuid -> clients on delete cascade, platform text, external_id text, primary key (client_id, platform, external_id))`, `targets(client_id, metric text, min_value numeric null, max_value numeric null, updated_at, primary key (client_id, metric))`, `conversations(id, tenant_id, client_id, user_id, title, created_at)`, `messages(id bigserial, conversation_id, role text, content jsonb, created_at)`, `usage_events(id bigserial, tenant_id, user_id, provider text, tokens_in int, tokens_out int, created_at)`, `insights_cache(key text pk, payload jsonb, expires_at timestamptz)`, `sites(id uuid pk, client_id, site_key text unique, allowed_origins text[], conversion_events text[] default '{purchase,form_submit}')`, `events(id bigserial, client_id, session_id text, name text, campaign_id text, adset_id text, ad_id text, url text, value numeric, currency text, ts timestamptz default now())`, plus RLS (members read only rows of their tenant; `events`/`sites` readable through client's tenant), service_role grants.

**Hub internal API** (auth headers `X-Hub-Secret`, `X-Tenant-Id`; env `HUB_SERVICE_SECRET`):
- `GET /internal/accounts` -> `[{"platform":"meta","external_id":"act_123"}]`
- `POST /internal/accounts` body `{"account","token"}` -> 201 `{"external_id"}`; `DELETE /internal/accounts/{external_id}` -> 200/404
- `GET /internal/tools` -> `[{"name","description","input_schema"}]`
- `POST /internal/tools/call` body `{"name","arguments"}` -> `{"result": <tool result>}` (tool runs with that tenant as current)

**Hub tools** (new): `meta_ads_insights(external_id: str, date_from: str, date_to: str, level: str = "campaign") -> dict` returning `{"currency","attribution","rows":[Row]}` where Row = `{"id","name","campaign_id","adset_id","ad_id","thumbnail_url","spend","impressions","link_clicks","landing_page_views","add_to_cart","purchases","purchase_value","ctr","cpc","cpm","roas"}` (rates `null` when denominator is 0); `ads_performance(client_id: str, date_from: str, date_to: str, level: str = "ad") -> dict` returning `{"currency","rows":[Row + {"sessions","add_to_cart_sessions","conversion_sessions","tracked_value","visit_rate","add_to_cart_rate","conversion_rate","tracked_roas"}], "unattributed":{"sessions","add_to_cart_sessions","conversion_sessions"}}`.

**Web module names** (`/web/src/lib`): `metrics.ts` (`computeRates`, `statusFor`, `DEFAULT_TARGETS`), `hub.ts` (`hubFetch`, `listAccounts`, `addAccount`, `removeAccount`, `listTools`, `callTool`), `tenant.ts` (`requireTenantContext(): Promise<{userId, tenantId, role}>`), `ai/provider.ts` (`AiProvider` interface), `ai/claude.ts`, `ai/openai.ts`, `ai/chat.ts` (`runChat`), `usage.ts` (`assertWithinCap`, `recordUsage`).

---

### Task 1: Hub insights parsing and `meta_ads_insights`

**Files:**
- Modify: `src/ads_api.py` (add `get_meta_insights`, `parse_insights_row`)
- Modify: `src/hosted_app.py` and `src/server.py` (register the tool; hosted version takes `external_id` and resolves the tenant token as existing tools do)
- Test: `tests/test_insights.py`

**Interfaces:**
- Produces: `parse_insights_row(raw: dict, level: str) -> dict` (the Row shape above), `get_meta_insights(date_from, date_to, level, token, account, version) -> dict` returning `{"currency","attribution","rows"}`; tool `meta_ads_insights` as in Shared contracts.

- [ ] **Step 1: Write failing tests** in `tests/test_insights.py` (follow header of `tests/test_hosted.py`): `test_parse_row_extracts_actions` (raw has `actions` list with `landing_page_view` 80, `add_to_cart` 20, `purchase` 5 and `action_values` purchase 500, spend "100", impressions "10000", `inline_link_clicks` "100" -> link_clicks 100, ctr 1.0, cpc 1.0, cpm 10.0, roas 5.0, add_to_cart 20, purchases 5, purchase_value 500); `test_zero_denominators_give_none` (impressions "0", inline_link_clicks "0" -> ctr/cpc/cpm/roas `None`, no exception); `test_missing_actions_are_zero`; `test_level_selects_ids_and_names` (level "ad" fills ad_id/ad name, level "campaign" leaves adset_id None); `test_request_uses_level_and_time_range` (mock `requests.get`, assert params `level`, `time_range` JSON with `since`/`until`, fields include `inline_link_clicks,actions,action_values`, Bearer header, version path); `test_hosted_tool_denies_foreign_account` (reuse in-memory store from test_hosted: tenant A asking tenant B's account gets the same denial message as `meta_campaign_insights`).
- [ ] **Step 2: Run** `python tests/test_insights.py` — expect ImportError/AttributeError.
- [ ] **Step 3: Implement** the two functions in `src/ads_api.py`; for `level="ad"` also request `creative` thumbnail (`ad_id` then `creative{thumbnail_url}` via the `ads` edge is out of scope: fetch `thumbnail_url` through the `ads?fields=id,creative{thumbnail_url}` edge once per call and map by ad id; if it fails return `None` thumbnails). Currency from `account_currency` field. `attribution` string is `"account default"`.
- [ ] **Step 4: Register** `meta_ads_insights` in both servers (hosted version reuses the ownership check and audit logging of `meta_campaign_insights`).
- [ ] **Step 5: Run** `python tests/test_insights.py` and the six existing files — all print `ALL TESTS PASSED`.
- [ ] **Step 6: Commit** `feat: meta_ads_insights tool`.

### Task 2: Hub internal API

**Files:**
- Create: `src/internal_api.py`
- Modify: `src/hosted_app.py` (route `/internal/*` to `internal_api.app` before the Bearer logic; 404 when `HUB_SERVICE_SECRET` is unset)
- Test: `tests/test_internal_api.py`

**Interfaces:**
- Consumes: `get_store()` methods `list_connections`, `add_connection`, `delete_connection`; `mcp` tool registry; `tenancy.set_current`, `Tenant`.
- Produces: the four endpoints in Shared contracts. Constant-time secret compare; tenant must exist (`store.get_tenant`) else 403.

- [ ] **Step 1: Write failing tests**: `test_disabled_without_secret_404`; `test_missing_or_wrong_secret_401`; `test_secret_without_tenant_header_400`; `test_unknown_tenant_403`; `test_public_routes_ignore_x_tenant_id` (`/mcp` with only `X-Tenant-Id` -> 401; `/admin/api/tenants` unaffected); `test_accounts_crud_isolated_per_tenant` (A adds `act_1`, B cannot list or delete it, B's delete returns 404); `test_add_account_rejects_bad_id_and_blank_token` (400); `test_tools_list_has_schemas`; `test_tools_call_runs_as_that_tenant` (call `list_my_accounts` for A and B, each sees only its own); `test_tools_call_unknown_tool_404`; `test_no_token_in_any_response`.
- [ ] **Step 2: Run** — expect failure.
- [ ] **Step 3: Implement** `internal_api.py` (Starlette app, same security-header wrapper pattern as `admin_app.SecurityHeaders`); tool execution through `mcp.call_tool(name, arguments)` inside `set_current(Tenant(...))`; errors return `{"error": ...}` with secret redaction reused from `admin_app.redact`.
- [ ] **Step 3b: Mount** in `hosted_app.TenantAuth`.
- [ ] **Step 4: Run** new test and the six existing files — all pass.
- [ ] **Step 5: Commit** `feat: hub internal API`.

### Task 3: SaaS migration

**Files:**
- Create: `supabase/migrations/002_saas.sql`
- Test: `tests/test_migration_002.py` (static checks)

**Interfaces:** Produces the tables listed under Shared contracts.

- [ ] **Step 1: Write failing test**: reads the SQL and asserts each table name, each RLS `enable row level security` line, a policy for each tenant-scoped table that references `memberships`, `grant ... to service_role`, and no `create policy` granting to `anon`.
- [ ] **Step 2: Run** — expect FileNotFoundError.
- [ ] **Step 3: Write the SQL** per Shared contracts. Policy pattern: `using (tenant_id in (select tenant_id from memberships where user_id = auth.uid()))`; for tables without `tenant_id` (`client_accounts`, `targets`, `sites`, `events`, `messages`) join through `clients`/`conversations`. Members may insert/update `targets`; only `owner` may insert/delete `clients`, `client_accounts`, `sites`. `events` insert only via service role (no client insert policy).
- [ ] **Step 4: Run** test — passes. **Step 5: Commit** `feat: saas schema`.
- [ ] **Step 6 (owner-run, cloud):** paste the file in Supabase SQL Editor and Run; success when the new tables appear in Table Editor.

### Task 4: `ads_performance` hub tool and events join

**Files:**
- Create: `src/performance.py`
- Modify: `src/store.py` (add to both stores: `get_client(tenant_id, client_id) -> dict | None`, `list_client_accounts(client_id) -> list[str]`, `events_summary(client_id, date_from, date_to, level) -> dict`), `src/hosted_app.py` (register tool)
- Test: `tests/test_performance.py`

**Interfaces:**
- Consumes: Task 1 `get_meta_insights` rows, Task 3 tables.
- Produces: tool `ads_performance` per Shared contracts; `merge_performance(meta_rows: list[dict], events: dict, conversion_events: list[str]) -> dict` (pure).

- [ ] **Step 1: Write failing tests**: `test_merge_counts_unique_sessions_per_ad` (3 add_to_cart events from 2 sessions on ad X -> add_to_cart_sessions 2); `test_rates_use_link_clicks_denominator` (clicks 100, sessions 80, atc sessions 14, conversion sessions 10 -> visit_rate 80.0, add_to_cart_rate 14.0, conversion_rate 10.0); `test_zero_clicks_gives_none`; `test_unattributed_bucket` (events with no ad id counted under `unattributed`); `test_tracked_roas` (tracked_value 900, spend 100 -> 9.0); `test_roas_source_meta_uses_meta_roas`; `test_foreign_client_denied` (tenant A asks tenant B's client_id -> same denial text style as other tools); `test_mixed_currency_accounts_rejected` (two accounts, currencies differ -> error message mentions currency).
- [ ] **Step 2: Run** — fail. **Step 3: Implement** `merge_performance` (pure), store methods (in-memory with lists, Supabase via table calls decorated with `db_call`), and the tool (iterates the client's accounts, sums totals by ad id, recomputes rates from sums). **Step 4: Run** new + six existing — pass. **Step 5: Commit** `feat: ads_performance tool`.

### Task 5: Web scaffold, auth, tenant context

**Files:**
- Create: `web/` Next.js app (`package.json`, `tsconfig.json`, `next.config.ts`, `src/app/(auth)/login/page.tsx`, `src/app/(app)/layout.tsx`, `src/middleware.ts`, `src/lib/supabase/{server,browser}.ts`, `src/lib/tenant.ts`, `.env.example`)
- Test: `web/src/lib/tenant.test.ts`

**Interfaces:**
- Produces: `requireTenantContext(): Promise<{userId: string; tenantId: string; role: "owner" | "member"}>` (redirects to `/login` when no session; throws `NoTenantError` when the user has no membership); `getMembership(supabase, userId)` helper.

- [ ] **Step 1: Scaffold** with `npx create-next-app@latest web --ts --tailwind --app --eslint --no-src-dir=false`, add `@supabase/ssr @supabase/supabase-js zod vitest`. `.env.example` lists `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public by design), `SUPABASE_SERVICE_ROLE_KEY`, `HUB_URL`, `HUB_SERVICE_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_PROVIDER`, `AI_MODEL_CLAUDE`, `AI_MODEL_OPENAI`, `AI_MONTHLY_TOKEN_CAP`, `APP_URL`.
- [ ] **Step 2: Write failing tests** in `tenant.test.ts` with a fake supabase client: `no session redirects to login`, `user without membership throws NoTenantError`, `returns tenantId and role from membership`, `ignores any tenant id in cookies or headers`.
- [ ] **Step 3: Run** `npm test` — fail. **Step 4: Implement** `tenant.ts`, middleware refreshing the session, `/login` (email + password, English, errors shown), logout route, `(app)/layout.tsx` guarding with `requireTenantContext`. Signup page absent (invite-only; accounts are created by the owner via Supabase Auth invite).
- [ ] **Step 5: Run** `npm test` and `npm run build` — both succeed. **Step 6: Commit** `feat(web): scaffold, auth, tenant context`.

### Task 6: Metrics library

**Files:**
- Create: `web/src/lib/metrics.ts`
- Test: `web/src/lib/metrics.test.ts`

**Interfaces:**
- Produces: `type MetricKey = "ctr" | "cpc" | "cpm" | "visit_rate" | "add_to_cart_rate" | "conversion_rate" | "roas"`; `type Status = "on_target" | "better" | "off_target" | "no_data"`; `DEFAULT_TARGETS: Record<MetricKey, {min: number | null; max: number | null}>` (values from Global Constraints); `DIRECTION: Record<MetricKey, "higher" | "lower">`; `statusFor(metric: MetricKey, value: number | null, band: {min: number | null; max: number | null}): Status`; `computeRates(t: Totals): Rates` with `Totals = {spend, impressions, linkClicks, sessions, addToCartSessions, conversionSessions, value}`.

- [ ] **Step 1: Write failing tests** (exact cases): `statusFor("roas", 10, {9,12}) -> on_target`; `("roas", 15, ...) -> better`; `("roas", 5, ...) -> off_target`; `("cpm", 10, {13,14}) -> better`; `("cpm", 20, ...) -> off_target`; `("cpc", 20, {null,20}) -> on_target`; `("ctr", null, ...) -> no_data`; `statusFor` with `NaN` or `Infinity` -> `no_data`; `computeRates` zero clicks -> null rates; `computeRates` sums-based example (clicks 100, sessions 80, atc 14, conv 10, spend 100, value 900 -> visit 80, atc 14, conv 10, roas 9).
- [ ] **Step 2-4: Run to fail, implement, run to pass** (`npm test`). **Step 5: Commit** `feat(web): metrics and status model`.

### Task 7: Hub client and clients/accounts/targets pages

**Files:**
- Create: `web/src/lib/hub.ts`, `web/src/app/(app)/clients/page.tsx`, `web/src/app/(app)/clients/[clientId]/layout.tsx`, `.../accounts/page.tsx`, `.../targets/page.tsx`, `web/src/app/api/clients/route.ts`, `web/src/app/api/clients/[clientId]/accounts/route.ts`, `.../targets/route.ts`
- Test: `web/src/lib/hub.test.ts`, `web/src/app/api/clients.test.ts`

**Interfaces:**
- Consumes: Task 5 `requireTenantContext`; Task 6 `DEFAULT_TARGETS`; hub internal API.
- Produces: `hubFetch(tenantId, path, init?)` (adds `X-Hub-Secret`, `X-Tenant-Id`, 20 s timeout, never logs headers); `listAccounts(tenantId)`, `addAccount(tenantId, account, token)`, `removeAccount(tenantId, externalId)`, `listTools(tenantId)`, `callTool(tenantId, name, args)`.

- [ ] **Step 1: Write failing tests**: hub client sends both headers and no browser-origin data; error responses become `HubError(status, message)` with no secret in message; `POST /api/clients` as `member` -> 403, as `owner` -> creates client and seeds `targets` rows from `DEFAULT_TARGETS`; owner of agency A requesting client of agency B at `/accounts` or `/targets` -> 404; adding an account whose currency differs from the client's existing accounts -> 400 with English message mentioning currency; token never appears in any API response.
- [ ] **Step 2-4: Run to fail, implement, run to pass.** Accounts page: form (account id + token, password input), list with remove. Targets page: table of 7 metrics, min/max inputs, Save (members allowed), "Reset to defaults".
- [ ] **Step 5: Commit** `feat(web): clients, accounts, targets`.

### Task 8: Dashboard

**Files:**
- Create: `web/src/app/(app)/clients/[clientId]/page.tsx` (Dashboard tab), `web/src/components/{KpiCard,PerformanceTable,DateRange,StatusBadge}.tsx`, `web/src/app/api/clients/[clientId]/performance/route.ts`
- Test: `web/src/app/api/performance.test.ts`, `web/src/components/PerformanceTable.test.tsx`

**Interfaces:**
- Consumes: `callTool(tenantId, "ads_performance", {...})` (falls back to `meta_ads_insights` per account when the client has no site yet, with tracking KPIs shown as "Tracking not set up"); `statusFor`, `computeRates`.
- Produces: `GET /api/clients/:id/performance?from&to&level` -> `{currency, totals, rows, unattributed}`.

- [ ] **Step 1: Write failing tests**: route returns 404 for another agency's client; invalid dates or level -> 400; range longer than 366 days -> 400; zero rows -> empty table state "No data for this period"; table cell shows status class for on_target / better / off_target / no_data; thumbnails are `<img>` with alt text and render ad names as text (a name like `<script>x</script>` appears literally); KPI cards show a definition tooltip.
- [ ] **Step 2-4: Run to fail, implement, run to pass.** Level switcher (campaign / ad set / ad), date presets (Last 7 days, Last 30 days, custom), loading and error states in English.
- [ ] **Step 5: Commit** `feat(web): dashboard`.

### Task 9: AI layer and Ads Assistant chat

**Files:**
- Create: `web/src/lib/ai/{provider,claude,openai,chat}.ts`, `web/src/lib/usage.ts`, `web/src/app/api/clients/[clientId]/chat/route.ts`, `web/src/app/(app)/clients/[clientId]/assistant/page.tsx`
- Test: `web/src/lib/ai/chat.test.ts`, `web/src/lib/usage.test.ts`

**Interfaces:**
- Produces: `interface AiProvider { complete(input: {system: string; messages: ChatMessage[]; tools: ToolDef[]}): Promise<{text: string; toolCalls: {id: string; name: string; arguments: unknown}[]; tokensIn: number; tokensOut: number}> }`; `runChat({tenantId, clientId, userId, conversationId, userMessage, provider}): AsyncIterable<ChatEvent>` with events `text`, `tool_use`, `done`, `error`; `assertWithinCap(tenantId): Promise<void>` (throws `CapReachedError`), `recordUsage(row)`.
- Tools given to the model: only `ads_performance` and `meta_ads_insights`, with `client_id` / account arguments forced server-side to the conversation's client (model-supplied values for them are ignored).

- [ ] **Step 1: Write failing tests** with a fake provider and fake hub: tool loop runs up to 5 rounds then stops; model-supplied `client_id` for another client is overwritten; tool output is wrapped as data in the prompt and a tool result containing "ignore previous instructions" does not change the system prompt; cap reached -> `error` event `"Monthly AI usage limit reached. Contact your agency owner."` and no provider call; provider throws -> `error` event with generic English message, no stack, no key; hub tool error -> assistant told the tool failed and continues; usage row written once per provider call; system prompt includes the client's targets and currency.
- [ ] **Step 2-4: Run to fail, implement** (Claude adapter via `@anthropic-ai/sdk`, OpenAI via `openai`; select by `AI_PROVIDER`; route streams server-sent events; `maxDuration` 60), **run to pass.** Chat UI: message list, input, suggested questions ("Which ads are off target this week?", "Where am I overspending?"), shows which tools were used.
- [ ] **Step 5: Commit** `feat(web): AI assistant`.

### Task 10: Conversation isolation and invites (owner tooling)

**Files:**
- Create: `web/src/app/api/clients/[clientId]/conversations/route.ts`, `web/src/app/(app)/settings/team/page.tsx`, `web/src/app/api/team/invite/route.ts`
- Test: `web/src/app/api/conversations.test.ts`, `web/src/app/api/invite.test.ts`

**Interfaces:** Consumes `requireTenantContext`; Produces conversation list/create routes and invite route (owner only; uses Supabase Auth admin invite with the service role, inserts `memberships` row with role `member`).

- [ ] **Step 1: Write failing tests**: agency B cannot read agency A's conversation id (404); member cannot invite (403); owner invite creates a membership for the owner's tenant only (tenant id ignored if sent in body); invite with an existing email in another tenant -> 409 English message.
- [ ] **Step 2-4: Run to fail, implement, run to pass. Step 5: Commit** `feat(web): conversations and team invites`.

### Task 11: Tracker script

**Files:**
- Create: `web/public/t.js` (source in `web/src/tracker/tracker.ts`, built to `public/t.js` by `npm run build:tracker` using esbuild), `web/src/tracker/tracker.test.ts`

**Interfaces:**
- Produces: `window.adsTrack(name: string, props?: {value?: number; currency?: string})`, `window.adsTrack.consent()`; script attributes `data-site-key`, `data-consent` (`auto` default, `manual`). Reads `utm_source`, `utm_campaign`, `utm_term`, `utm_content`, `fbclid` from URL; stores first touch in `localStorage` key `adsmcp_ft` for 30 days with anonymous `session_id` (random 128-bit); sends JSON `{site_key, session_id, name, campaign_id, adset_id, ad_id, url, value, currency}` with `navigator.sendBeacon` to `<script origin>/api/collect`. Never sends form field values.

- [ ] **Step 1: Write failing tests** (jsdom): page view sent on load with ad ids from `utm_*`; first touch persists and later `form_submit` carries the stored ad ids when the URL has none; expired (31 days) first touch is dropped; `data-consent="manual"` sends nothing until `adsTrack.consent()`; auto form detection sends `form_submit` with no field values; payload contains no `email|phone|name` keys.
- [ ] **Step 2-4: Run to fail, implement, run to pass; build file < 4 KB gzipped (test asserts).** **Step 5: Commit** `feat(web): tracker script`.

### Task 12: Collector, sites UI, tracking health

**Files:**
- Create: `web/src/app/api/collect/route.ts`, `web/src/app/(app)/clients/[clientId]/tracking/page.tsx`, `web/src/app/api/clients/[clientId]/site/route.ts`
- Test: `web/src/app/api/collect.test.ts`, `web/src/app/api/site.test.ts`

**Interfaces:** Consumes Task 3 `sites`, `events`; Produces `POST /api/collect` (CORS only for the site's allowed origins; `204` on success), site create/rotate-key route (owner only), health query `{eventsLast24h, sessionsMissingAdIds, lastEventAt}`.

- [ ] **Step 1: Write failing tests**: unknown `site_key` -> 404 and nothing stored; `Origin` not in `allowed_origins` -> 403 and nothing stored; body with `email`, `phone` or `name` -> 400; body over 4 KB -> 413; unknown event name -> 400; valid event stored with `ip` never persisted; rate limit (60 events/min per site key + session) returns 429; CORS preflight allowed only for allowed origins; health query counts only the caller's client; copy-paste snippet and ad URL-parameter template shown on the tracking page.
- [ ] **Step 2-4: Run to fail, implement (service-role insert), run to pass. Step 5: Commit** `feat(web): collector and tracking setup`.

### Task 13: Cross-tenant end-to-end and deployment docs

**Files:**
- Create: `web/src/e2e/isolation.test.ts`, `docs/deploy-saas.md`
- Modify: `.env.example`, `docs/solution-b-design.md` (link to deploy doc)

- [ ] **Step 1: Write failing test** `isolation.test.ts` with two fake agencies against the route handlers: every route in Tasks 7, 8, 9, 10, 12 returns 404/403 for the other agency's ids; no response contains the other agency's account ids.
- [ ] **Step 2-4: Run to fail, fix any gap found, run to pass.** Write `docs/deploy-saas.md`: create Vercel project B (root directory `web`), env vars table with where each value comes from, set `HUB_SERVICE_SECRET` in both projects (same random 32+ chars), run `002_saas.sql`, create first owner (Supabase Auth invite) and membership row, add allowed origins for tracker, smoke-test checklist (login, add client, connect account, dashboard loads, chat answers, tracker event arrives). 
- [ ] **Step 5: Run everything**: all Python test files and `npm test`, `npm run build`. **Step 6: Commit** `feat: isolation e2e and deploy docs`.
