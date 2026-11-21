# Phase 2A: Approve and Apply (pause / scale / resume) Implementation Plan

**Goal:** From the Actions tab an owner can approve a verdict and the platform changes Meta: pause an ad, raise a budget by at most 20%, or resume a paused ad. Everything is logged. Campaign launcher is Phase 2B (not here).

**Architecture:** The hub holds the Meta tokens, so it gets two write tools. They are reachable only from the web app's internal API (shared secret) and only when `ENABLE_META_WRITES=1`; never over the public `/mcp` endpoint that customers' AI clients use. The web app recomputes the verdict on the server (never trusts the browser), checks the change is allowed, calls the hub, and writes an `action_log` row.

**Spec:** Phase A plan (docs/superpowers/plans/2026-11-21-phase-a-actions.md), contract types in `web/src/lib/actions/types.ts` (section "Phase 2A"). Automation level 2 from the research: one-click approve; Scale = +20% max every 3 days.

## Global Constraints
- English UI/messages. Hub Python (`/src`), web TypeScript (`/web`). `.gitignore` ignores `lib/`: `git add -f web/src/lib`. No node_modules/pycache in commits.
- Writes OFF by default (`ENABLE_META_WRITES` unset). With writes off the UI shows a clear "Changes in Meta are not enabled" state.
- Budget increase only: percent integer 1..20; never decrease via scale; never touch lifetime budgets (refuse with a message).
- Only the account's own objects: the hub verifies the object's `account_id` equals the connected account before writing.
- Only tenant owners can apply (members see buttons disabled with the reason).
- Every attempt (ok or error) is logged in `action_log`; the hub also writes its existing audit log.

## Review Focus
- A customer's MCP API key must never be able to call the write tools over `/mcp`.
- Object id belonging to another account/client must be refused.
- Double click / retry must not raise the budget twice (3-day cooldown per ad set/campaign, checked against `action_log`).
- Budget on campaign (CBO) vs ad set: refuse cleanly or fall back; never write 0 or a decrease.
- Meta permission error (token lacks `ads_management`) becomes a plain message, not a 500.

## Tasks (all four in parallel; they only share the contract)

### T1 Hub write tools
Files: `src/ads_api.py`, `src/hosted_app.py`, `src/internal_api.py`, `tests/test_writes.py` (new).
- `ads_api.set_object_status(object_id: str, status: str, token: str, account: str, version: str | None = None) -> dict` (status in `ACTIVE`/`PAUSED`; GET `?fields=account_id,status`, compare account, POST status; returns `{"before": {"status"}, "after": {"status"}}`).
- `ads_api.raise_budget(object_id: str, percent: int, token: str, account: str, version: str | None = None) -> dict` (GET `fields=account_id,daily_budget,lifetime_budget`; refuse lifetime budgets and missing/zero `daily_budget` with `MetaError("budget_not_here: ...")`; new = round(old*(1+percent/100)), at least old+1 minor unit; POST `daily_budget`; returns `{"before": {"daily_budget"}, "after": {"daily_budget"}}` in minor currency units as ints).
- A `_meta_post(url, token, data)` helper next to `_meta_get` (same error mapping; a Meta permission error 200/10/#200 becomes `MetaError("permission: the connected token cannot change ads (ads_management is missing).")`).
- Hosted tools in `hosted_app.py`: `meta_set_status(external_id, object_id, level, status)` and `meta_raise_budget(external_id, object_id, level, percent)`; `level` in ad/adset/campaign. Both refuse unless `os.environ["ENABLE_META_WRITES"] == "1"` AND the call came through the internal API (a ContextVar `writes_allowed` set only in `internal_api.tools_call`; over `/mcp` it is False -> error "Write tools are not available on this connection."). Same tenant/account access check as `meta_ads_insights`, and `store.log_audit(...)` for every call (ok/denied/error). percent validated 1..20.
- Tests (mock `requests`): status change ok; wrong account refused; lifetime budget refused; +20% math (1000 -> 1200, 5 -> 6); percent 21 and 0 refused; writes env off refused; `/mcp` path refused; permission error mapped; audit logged.

### T2 Migration 006
Files: `supabase/migrations/006_action_log.sql`, `tests/test_migration_006.py` (style of test_migration_005).
- `action_log(id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, client_id uuid not null references clients(id) on delete cascade, user_id uuid, ad_id text not null, ad_name text, action text check in (pause,scale,resume), level text check in (ad,adset,campaign), object_id text not null, before jsonb not null default '{}', after jsonb not null default '{}', status text check in (ok,error), error text, created_at timestamptz not null default now())`; index `(client_id, created_at desc)`; RLS on: members of the tenant can select; insert allowed for members of the tenant where `user_id = auth.uid()`; no update/delete policies; grants like 005.

### T3 Web apply API
Files: `web/src/lib/actions/apply.ts`, `web/src/app/api/clients/[clientId]/apply/route.ts`, tests.
- `POST apply` body `ApplyRequest` -> `ApplyResponse`; `GET apply` -> `ApplyLogResponse` (last 50, `writes_enabled` from a hub probe-free flag: env `NEXT_PUBLIC`-free server env `WRITES_ENABLED_HINT` is NOT used; instead treat a hub error containing "not enabled" as disabled; GET returns `writes_enabled: true` unless the last attempt failed with that error).
- Rules: owner only (403 otherwise); load actions with `loadActionsData` (server recomputes); ad must exist in the client's ad list; `pause` requires verdict `pause`; `scale` requires verdict `scale`, cooldown 3 days per target object from `action_log`, percent 20 (use the lowest of 20 and any smaller setting), level adset (ad's `adset_id`), if the hub says `budget_not_here` retry once with level campaign, else 409 with the plain message; `resume` allowed only if the latest ok log for that ad is a `pause`. Hub error mapping: "not enabled/not available" -> 409 "Changes in Meta are not enabled on this platform yet."; "permission" -> 409 with the permission message; other hub failure -> 502. Always insert an `action_log` row (ok or error) with before/after.
- Tests: each rule, cooldown, double submit, non-owner, unknown ad, hub errors, log written on error.

### T4 UI
Files: `web/src/components/actions/` (AdActionsTable buttons, `ApplyConfirm`, `ChangeLog`), actions page wiring, tests.
- In the ads table: for verdict pause a "Pause in Meta" button, for scale a "Raise budget 20%" button, for ads whose last log is a pause a "Resume" button. Click opens a confirm dialog that states exactly what will change ("Pause ad X in Meta. You can resume it later.") and requires one more click. Buttons disabled with a reason for non-owners and during cooldown. Result toast uses `note`. Errors show the API's message. "Recent changes" list under the table from `GET apply`. Copy states clearly that this changes the live Meta account.
