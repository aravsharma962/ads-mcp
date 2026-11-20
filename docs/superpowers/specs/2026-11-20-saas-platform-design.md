# Ads Platform SaaS: design

Date: 2026-11-20. Status: draft for owner approval. Written for a builder who cannot ask the owner questions.

## 1. Intent and why

The owner (Amit, India-based, Windows, builds with Claude Code) wants to sell a professional, fully cloud-hosted SaaS to marketing agencies. An agency logs in through a browser, connects its clients' Meta ad accounts, sets performance targets per client, sees how every campaign / ad (video) performs against those targets, and talks to an "Ads Assistant" chat that answers questions about the data. Nothing runs on the owner's or the agency's computer.

The owner also wants the existing Python MCP server to become his long-term **MCP hub**: a single place where more tools (Google Ads next, others later) are added over time. The SaaS web app is the first customer of that hub.

Origin of the requirements: a client's handwritten target list (CTR 3%+, CPC max Rs 20, CPM Rs 13-14, add-to-cart 14-16%, conversion 10-12%, ROAS 9-12x, plus items the owner has asked to ignore for now). The owner decided these numbers must NOT be hard-coded: users enter targets themselves.

## 2. Users

- **Agency member** (primary): signs up, belongs to one agency (tenant), manages clients, views dashboard, uses chat.
- **Platform owner** (Amit): administers tenants through the existing `/admin` panel on the hub (kept as is).
- Agency's own clients do not log in (non-goal for now).

## 3. Goals

1. Email signup/login for agency members; strict isolation between agencies.
2. Clients (brands) inside an agency; each client has one or more Meta ad accounts.
3. Per-client editable targets for: CTR, CPC, CPM, add-to-cart rate, conversion rate, ROAS (min and/or max per metric). Sensible defaults prefilled from the client's list.
4. Dashboard per client with a date range, showing at campaign, ad set and **ad (video/creative)** level: spend, impressions, clicks, landing page views (website visits), add-to-cart, purchases (sales), revenue, and the derived rates, each KPI coloured by target status (within / outside / no data).
5. Ads Assistant chat (English) grounded in the client's data and targets; answers like "Which ads are below target ROAS this week?".
6. AI provider is switchable: Claude (default) and OpenAI, both through the owner's API keys held server-side.
7. The Python hub gains the new data tools needed by the dashboard; existing tools and tests keep working.

## 4. Non-goals (this design)

Meta OAuth "Connect" button, billing/plans, Google Ads, audiences (lookalike builder), creative-hook and hold-rate analysis, any write action on ad accounts (pause, budget), client-facing logins, mobile app, white-label branding. Each is a later phase. The MVP is read-only.

## 5. Anti-goals (a technically working build that is still a failure)

- One agency can ever see another agency's data, tokens, targets or chats.
- A secret (Meta token, API keys, service secrets) reaches a browser or a log.
- Dashboard numbers that silently differ from Meta Ads Manager without the user being told the definition.
- UI text in any language other than English.

## 6. Constraints

- **Python hub is not rewritten.** It stays Python/FastMCP/Starlette, deployed on Vercel, store = Supabase. It may be extended (new tools, new internal endpoints) but existing behaviour and tests are preserved.
- Web app in TypeScript (owner allowed). UI language: English.
- Vercel (Hobby is non-commercial: Vercel Pro before charging anyone), Supabase, owner's Claude and OpenAI API keys.
- Meta Marketing API v27.0, read-only (`ads_read`). Serving other businesses' ad accounts at scale needs Meta App Review / Tech Provider status; for MVP agencies paste a system-user token they create themselves.
- Hub rule already in force: tenant identity is derived from authentication, never from tool arguments.

## 7. Approaches considered

| | Description | Trade-off |
|---|---|---|
| 1 (chosen by owner) | Next.js web app + existing Python hub as separate service | Best UI, reuses tested Python; two deployments |
| 2 | Everything in Python with server-rendered templates | One deployment; unprofessional UI, hard to evolve |
| 3 | Everything in TypeScript, rewrite hub | One language; discards tested code, owner said not to change Python |

Owner picked 1 and added: Python stays the MCP hub; TypeScript is fine for the web design.

## 8. Architecture

Monorepo, two Vercel projects from one GitHub repo:

- `/` (existing): Python hub. Project A. Public MCP endpoint `/mcp` (Bearer tenant key, unchanged), `/admin` (unchanged), plus a new **internal API** (below).
- `/web`: Next.js (App Router, TypeScript), Supabase Auth, Tailwind. Project B (root directory `web`).

Request paths:
1. Browser -> web (Supabase session cookie). Web server code verifies the session and resolves the agency (tenant) from membership. Tenant is never taken from browser input.
2. Web server -> hub, server-to-server, over HTTPS, using `HUB_SERVICE_SECRET` plus an `X-Tenant-Id` header set by web from the verified session. The hub accepts this pair only on the internal API and the internal MCP route, never on public routes. (Owner-level risk: if web has a bug, tenant isolation depends on it. Mitigations: secret only in web server env, hub logs every internal call with tenant id, cross-tenant tests in both repos.)
3. Hub -> Meta Graph API using the tenant's encrypted token from Supabase (existing mechanism).
4. Chat: web server route calls the AI provider with the hub's tools; tool calls are executed against the hub through the internal MCP route for that tenant. Streaming responses; conversation and messages stored in Supabase.

Hub additions (Python):
- Tool `meta_ads_insights(external_id, date_from, date_to, level)` with `level` in campaign / adset / ad; returns spend, impressions, clicks, inline link clicks, CTR, CPC, CPM, landing page views, add-to-cart, purchases, purchase value, ROAS (parsed from Meta `actions` / `action_values`), plus ad name and creative thumbnail URL where available. Existing tools untouched.
- Internal REST for web: add/remove a client's ad-account connection (token encrypted by the hub; the plaintext token never persists in web), list connected accounts for a tenant.
- Short-lived cache of Meta insights responses in Supabase (TTL minutes) to stay inside Meta rate limits and make the dashboard fast.

AI layer (web, TypeScript): a small provider interface (`complete(messages, tools) -> stream`) with Claude and OpenAI adapters; default provider and model names come from env/config; per-tenant monthly token cap with usage rows.

## 9. Data model additions (Supabase)

Existing: tenants, api_keys, ad_connections, audit_log.
New: `profiles/memberships` (auth user -> tenant, role), `clients` (tenant, name, currency, timezone), `client_accounts` (client -> ad_connections), `targets` (client, metric, min, max, updated_by), `conversations`, `messages`, `usage_events`, `insights_cache`.
Row Level Security on every new table keyed by the user's tenant membership. Hub keeps using the service role.

## 10. Screens (all English)

- Auth: sign up, log in, forgot password.
- Clients: list, create; client page tabs: Dashboard, Targets, Accounts, Assistant.
- Targets: table of metrics with min/max inputs; defaults CTR >= 3, CPC <= 20, CPM 13-14, add-to-cart rate 14-16, conversion rate 10-12, ROAS 9-12 (editable per client).
- Dashboard: date-range picker, KPI cards with status colour, a table switchable by level (campaign / ad set / ad), row shows the ad thumbnail, name, and metrics with per-cell target status.
- Assistant: chat panel with suggested questions; shows which data/tools it used.

## 11. Metric definitions (builder: show these in a tooltip in the UI)

My calls, to be confirmed in review: CTR = link clicks / impressions; CPC = spend / link clicks; CPM = spend / impressions x 1000; website visits = landing page views; add-to-cart rate = unique ad-attributed sessions with an `add_to_cart` event / link clicks; conversion rate = unique ad-attributed sessions with a conversion event (`purchase` or `form_submit`, configurable per client) / link clicks; website visit rate = unique ad-attributed sessions seen by the tracker / link clicks; ROAS = tracked purchase value / spend (client setting: use Meta's own `purchase_roas` instead). See section 17. Currency and date boundaries follow the ad account's currency and timezone.

## 12. Security

- API keys, service secret, Meta tokens only in server env / encrypted at rest; never in browser bundles (no `NEXT_PUBLIC_` for secrets).
- Tool results from Meta (ad names, text) are untrusted data in the chat prompt; the assistant has read-only tools only in MVP.
- Per-tenant rate limits on chat and insights; audit log for internal hub calls; error messages redact secrets (already implemented in the hub admin).
- Privacy policy and terms pages exist before first external customer.

## 13. Phases

1. **MVP**: auth, clients, accounts (token paste), targets, dashboard, chat with Claude (OpenAI adapter present, behind a setting).
2. Meta OAuth connect; insights cache hardening; usage caps UI.
3. Billing (Razorpay or Stripe, decided later), Vercel Pro, Meta App Review.
4. Google Ads tools in the hub and in the dashboard; audiences (lookalike); creative hook/hold-rate analytics.

## 14. Testing

Hub: existing five Python test files keep passing; new tests for `meta_ads_insights` (mocked Meta), internal API auth (rejects missing/incorrect secret, rejects tenant header on public routes), cross-tenant isolation. Web: unit tests for metric maths and target status; integration test that a second agency's session cannot read the first's client, targets, conversations; end-to-end smoke (login, add client, see dashboard with mocked hub).

## 15. Left to the builder

Component library and styling details, folder structure inside `/web`, exact table libraries, chat streaming implementation, caching TTL values, naming of internal endpoints, exact RLS policy text, migration file split, model names (use owner-configurable env values).

## 16. Decisions made after builder review (marked: author's calls unless noted)

1. **Attribution window (author's call):** use the Meta ad account's default attribution setting, same as Ads Manager columns, and show it in the dashboard tooltip. The window is not configurable in the MVP.
2. **Signup and roles (author's call):** MVP is invite-only. The owner creates the agency in the existing `/admin` and invites its first member by email; that member can invite teammates. Open self-serve signup is OFF until per-tenant token caps and rate limits are live. Roles: `owner` (invites members, manages clients and accounts) and `member` (views, edits targets, uses chat). Default cap: 200,000 AI tokens per tenant per month (owner-configurable).
3. **Status model (author's call):** each metric has a direction (CTR, add-to-cart rate, conversion rate, ROAS: higher is better; CPC, CPM: lower is better). The min/max pair is the acceptable band. Status is `on target` (inside the band), `better` (beyond the favourable edge, shown positive, not as a failure), `off target` (beyond the unfavourable edge), `no data`.
4. **Currency/timezone per client (author's call):** all ad accounts of one client must share currency and timezone; connecting a mismatching account is rejected with a clear message. Rates are always recomputed from summed totals, never averaged.
5. **Chat scope (author's call):** a conversation belongs to one client (`conversations.client_id`); the assistant's tools are restricted to that client's accounts. An agency-wide assistant is a later phase.
6. **Owner decided:** add-to-cart and conversion are measured against ad link clicks, and are tracked by the owner's own JavaScript tracker on the client's website (section 17), not the Meta pixel.

## 17. First-party tracking (owner's requirement)

Owner: "people click the ad; how many then add to cart or fill the form? We will track that with our own JavaScript code on the website."

**Tracker script.** Served by the web app (`/t.js`). A client site includes `<script async src="https://<app>/t.js" data-site-key="<public key>"></script>`. It records a page view with UTM parameters and `fbclid`, stores first touch (ad ids from the URL) in a first-party cookie/localStorage for 30 days, so a form submitted later is still credited to the ad, and exposes `window.adsTrack(eventName, {value, currency})` for `add_to_cart`, `form_submit`, `purchase`. Optional automatic detection of form submissions. Sends events with `navigator.sendBeacon`.

**Attribution.** The agency sets URL parameters on each ad: `utm_source=facebook&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`. The tracker reads them. The platform shows a copy-paste snippet and a "tracking health" check per client (events seen in the last 24h, share of sessions missing ad ids).

**Collector.** Public endpoint in the web app (`/api/collect`). Site key (public identifier) maps to a client; per-client allowed-origins list; rate limit and basic bot filtering; no raw IP stored (hash with daily salt), no personal data fields (names, emails, phone numbers) accepted. Rows go to a new `events` table (client_id, anonymous session id, event name, campaign/adset/ad ids, page URL, value, currency, ts).

**Dashboard maths.** Spend, impressions, link clicks come from Meta (hub); sessions and events come from `events`; both are joined by ad id inside a new hub tool `ads_performance(client, date range, level)` so metric logic lives in one place and the chat uses the same numbers. Unique sessions are counted, not raw events.

**Honest limits (show in the UI help):** tracked numbers will differ from Meta Ads Manager (ad blockers, missing URL parameters, consent choices). Ratios against clicks can exceed expectations when clicks are bot clicks, and ads without URL parameters appear as "unattributed".

**Privacy:** the agency/client is responsible for cookie notice and consent on their site (India DPDP Act and any other applicable law); the tracker supports a `data-consent="manual"` mode where tracking only starts after the site calls `adsTrack.consent()`.

**Phasing change:** Phase 1a = auth, clients, accounts, targets, dashboard with Meta-native metrics (spend, impressions, clicks, CTR, CPC, CPM, Meta ROAS) and chat. Phase 1b = tracker, collector, attribution, `ads_performance`, and the add-to-cart / conversion / website-visit KPIs. Both are MVP; 1a ships first.

New tables: `sites` (client, site key, allowed origins), `events`. New RLS: agency members read only their clients' events; the collector writes with the service role.
