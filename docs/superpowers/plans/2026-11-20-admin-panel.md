# Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser-based `/admin` page so the owner can create tenants, API keys and Meta connections without the command line.

**Architecture:** A small Starlette app (`admin_app.py`) mounted inside the existing `TenantAuth` ASGI wrapper: paths starting with `/admin` skip the Bearer-key check and go to the admin app, which has its own password + signed-cookie auth. UI is one static HTML file with vanilla JS calling JSON endpoints under `/admin/api/`. All data goes through `store.py` (same encryption/hashing as the CLI).

**Tech Stack:** Python 3.12, Starlette (already installed via `mcp`), stdlib `hmac`/`hashlib`, existing `InMemoryStore`/`SupabaseStore`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-admin-panel-design.md`

## Global Constraints

- `/admin` is disabled (404 for every `/admin*` path) when `ADMIN_PASSWORD` is unset or empty.
- Auth: password from env `ADMIN_PASSWORD`, compared with `hmac.compare_digest`; session cookie `admin_session`, HttpOnly, SameSite=Strict, Secure unless host is localhost, 8h expiry, HMAC-signed (key = `ADMIN_SESSION_SECRET`, falling back to sha256 of `ADMIN_PASSWORD`).
- Login rate limit: 5 failed attempts per client IP per 15 minutes, then 429.
- Every non-GET `/admin/api/*` request requires header `X-Admin: 1` (else 403).
- Raw API key appears only in the create-key response. Tokens and `token_enc` never appear in any response, log line or exception message.
- UI renders server data with `textContent` only, never `innerHTML`.
- No new pip dependencies. Tests run with `STORE=memory` and a generated `TOKEN_ENC_KEY`, as in `tests/test_hosted.py`.

## Review Focus

- `ADMIN_PASSWORD` unset: `/admin` and `/admin/api/*` must not be reachable (404), never open by default. (Task 3)
- Tampered, expired or other-secret cookie is rejected like no cookie. (Task 2)
- Empty or blank tenant name, empty token, or account id typed without `act_` prefix: reject blanks with 400; normalize `123` to `act_123`; strip whitespace around token. (Task 3)
- Cross-tenant mix-ups: revoking a key id or deleting a connection through the wrong tenant's URL must change nothing and return 404. (Tasks 1, 3)
- Stored-XSS: a tenant named `<img src=x onerror=alert(1)>` must display as text. (Task 4)

---

### Task 1: Store admin methods

**Files:**
- Modify: `src/store.py` (both `InMemoryStore` and `SupabaseStore`)
- Test: `tests/test_store_admin.py`

**Interfaces:**
- Produces on both stores (these exact signatures):
  - `list_tenants() -> list[dict]` — each `{"id","name","plan"}`, newest first.
  - `get_tenant(tenant_id: str) -> dict | None` — same shape.
  - `list_keys(tenant_id: str) -> list[dict]` — each `{"id","label","created_at","revoked_at"}`; never `key_hash`.
  - `revoke_key_by_id(tenant_id: str, key_id: str) -> bool` — True only if a key with that id belongs to that tenant and was active.
  - `delete_connection(tenant_id: str, platform: str, external_id: str) -> bool` — True if a row was removed.
- `InMemoryStore.create_api_key` now also stores `id` (uuid4 str) and `created_at` on each key dict.
- Existing method signatures are unchanged.

- [ ] **Step 1: Write failing tests** in `tests/test_store_admin.py` (follow the env setup at the top of `tests/test_hosted.py`): `test_list_tenants_and_get`, `test_list_keys_hides_hash_and_shows_revoked`, `test_revoke_by_id_wrong_tenant_returns_false_and_key_still_works` (assert `resolve_api_key(raw)` still returns the tenant), `test_revoke_by_id_right_tenant_blocks_resolve`, `test_delete_connection_wrong_tenant_false_and_token_still_readable`, `test_delete_connection_removes`.
- [ ] **Step 2: Run** `python tests/test_store_admin.py` — expect AttributeError on missing methods.
- [ ] **Step 3: Implement** the five methods in `InMemoryStore`. 
- [ ] **Step 4: Implement** the same in `SupabaseStore` using `self.db.table(...)` with `.eq("tenant_id", ...)` on every filter; `revoke_key_by_id` and `delete_connection` filter on tenant AND id/external_id and return whether `.data` is non-empty; `list_keys` selects `id, label, created_at, revoked_at` only.
- [ ] **Step 5: Run** the test file — expect `ALL TESTS PASSED` printed at the end (match the style of `test_hosted.py`).
- [ ] **Step 6: Commit** `feat: store methods for admin panel`.

### Task 2: Admin auth helpers

**Files:**
- Create: `src/admin_auth.py`
- Test: `tests/test_admin_auth.py`

**Interfaces:**
- Produces:
  - `admin_enabled() -> bool` (reads `ADMIN_PASSWORD` on every call so tests can set env).
  - `check_password(candidate: str) -> bool`.
  - `make_session(now: float | None = None) -> str` — cookie value `"<expiry_unix>.<hex hmac>"`.
  - `verify_session(value: str, now: float | None = None) -> bool`.
  - `class LoginLimiter: allowed(ip: str, now: float | None = None) -> bool; fail(ip: str, now: float | None = None) -> None; reset(ip: str) -> None` (module-level instance `limiter`).

- [ ] **Step 1: Write failing tests**: `test_disabled_when_unset`, `test_check_password_right_and_wrong`, `test_session_roundtrip`, `test_session_expired_after_8h`, `test_session_tampered_signature_and_expiry_rejected`, `test_session_with_other_secret_rejected`, `test_garbage_cookie_values_rejected` (empty string, no dot, non-numeric expiry), `test_limiter_blocks_after_5_fails_and_recovers_after_15min`.
- [ ] **Step 2: Run** — expect ImportError.
- [ ] **Step 3: Implement** with stdlib only; signature covers the expiry string; compare with `hmac.compare_digest`.
- [ ] **Step 4: Run** — all pass.
- [ ] **Step 5: Commit** `feat: admin auth helpers`.

### Task 3: Admin JSON API, mounted in hosted app

**Files:**
- Create: `src/admin_app.py`
- Modify: `src/hosted_app.py` (`TenantAuth.__call__`: if `scope["path"]` starts with `/admin`, delegate to `admin_app.app` before the Bearer logic; `/health` and `/mcp` behavior unchanged)
- Test: `tests/test_admin_api.py`

**Interfaces:**
- Consumes: Task 1 store methods, Task 2 helpers, `get_store()`, the account-normalizing rule currently in `hosted_app._norm_account`. `hosted_app` imports `admin_app`, so importing back would be circular: move it to `tenancy.py` as `norm_account(external_id: str) -> str` and make both modules use it.
- Produces `admin_app.app` (Starlette). Endpoints (JSON in/out):
  - `POST /admin/api/login {"password"}` → 200 + `Set-Cookie`, or 401, or 429.
  - `POST /admin/api/logout` → 200, cookie cleared.
  - `GET /admin/api/tenants` → `[{"id","name","plan"}]`.
  - `POST /admin/api/tenants {"name"}` → 201 `{"id","name","plan"}`; blank name → 400.
  - `GET /admin/api/tenants/{tid}` → `{"tenant", "keys", "connections"}`; unknown tid → 404.
  - `POST /admin/api/tenants/{tid}/keys {"label"}` → 201 `{"key": "<raw>"}`.
  - `DELETE /admin/api/tenants/{tid}/keys/{kid}` → 200, or 404 if not that tenant's active key.
  - `POST /admin/api/tenants/{tid}/connections {"account","token"}` → 201 `{"external_id"}`; blank token/account → 400.
  - `DELETE /admin/api/tenants/{tid}/connections/{external_id}` → 200 or 404.
  - Every `/admin/api/*` except login requires a valid session cookie (else 401); non-GET requires `X-Admin: 1` (else 403). Store calls run via `anyio.to_thread.run_sync`.

- [ ] **Step 1: Write failing tests** (use `TestClient(hosted_app.app)` inside one `with` block, `STORE=memory`, `ADMIN_PASSWORD=pw-test`): `test_disabled_without_password_returns_404` (separate process run or env toggled before first request), `test_api_without_cookie_401`, `test_wrong_password_401_and_6th_attempt_429`, `test_post_without_x_admin_header_403`, `test_full_flow` (login → create tenant → create key → add connection `"123"` with token `" TOK_SECRET "` → GET tenant shows `act_123` → the new key calls `/mcp` `list_my_accounts` and sees `act_123`), `test_no_secret_leaks` (collect every response body after the key creation; assert `TOK_SECRET`, the stored `token_enc`, and the raw key do not appear, except raw key in the one create-key response), `test_blank_inputs_400`, `test_wrong_tenant_revoke_and_delete_404_and_unchanged`, `test_revoke_then_mcp_401`, `test_mcp_and_health_unchanged` (Bearer rules still apply; `/admin/api/tenants` is not reachable with a Bearer tenant key).
- [ ] **Step 2: Run** `python tests/test_admin_api.py` — expect failures (404s/import errors).
- [ ] **Step 3: Implement** `admin_app.py` and the `hosted_app.py` delegation; move `norm_account` to `tenancy.py`. Cookie `Secure` flag off when request host is `localhost`/`127.0.0.1`. Error responses are generic JSON `{"error": "..."}`; never echo the token.
- [ ] **Step 4: Run** `tests/test_admin_api.py` and the existing `tests/test_hosted.py` — both pass.
- [ ] **Step 5: Commit** `feat: admin JSON API`.

### Task 4: Admin page (HTML + JS)

**Files:**
- Create: `src/admin_page.html`
- Modify: `src/admin_app.py` (add `GET /admin` serving the file; public, it contains no data)
- Test: `tests/test_admin_page.py`

**Interfaces:**
- Consumes: Task 3 endpoints.
- Produces: `GET /admin` → `text/html`. Page behavior: login form (password) → after login shows tenant list + "Create agency" form; selecting a tenant shows its keys (label, created, revoked) with Revoke button, "Create API key" (key shown once in a box with Copy button, plus a note to save it), connections list with Remove button, and an "Add Meta account" form (account id text, token `type=password`). All dynamic text set via `textContent`; every fetch sends `X-Admin: 1`; a 401 response returns the UI to the login form.

- [ ] **Step 1: Write failing tests**: `test_page_served_without_login_and_has_no_data`, `test_page_never_uses_innerHTML` (read the file, assert the substring is absent), `test_page_sends_x_admin_header` (substring check), `test_token_input_is_password_type`, `test_page_404_when_disabled`.
- [ ] **Step 2: Run** — fail (404).
- [ ] **Step 3: Implement** the page and the route; plain CSS, mobile-friendly, Hinglish labels allowed.
- [ ] **Step 4: Run** the new tests plus Task 3's — pass.
- [ ] **Step 5: Manual check** (owner, Chrome): `set STORE=memory`, `set ADMIN_PASSWORD=...`, `set TOKEN_ENC_KEY=...`, run `uvicorn hosted_app:app --app-dir src --port 8000`, open `http://localhost:8000/admin`, create an agency named `<img src=x onerror=alert(1)>` and confirm it shows as plain text with no popup.
- [ ] **Step 6: Commit** `feat: admin page`.

### Task 5: Docs, env, real Supabase and Vercel check

**Files:**
- Modify: `.env.example` (add blank `ADMIN_PASSWORD=` and `ADMIN_SESSION_SECRET=`), `docs/solution-b-design.md` (onboarding section: use `/admin`; CLI stays as fallback; fix `add-account` to `add-meta`), `supabase/migrations/001_init.sql` already has grants.

- [ ] **Step 1: Update** the three files above.
- [ ] **Step 2: Real Supabase check** (owner): add `ADMIN_PASSWORD` to local `.env`, run uvicorn without `STORE=memory`, open `/admin`, create agency, key, add Meta account with the real token; confirm rows in Supabase Table Editor and that `token_enc` is not the plain token; call `/mcp` with the new key.
- [ ] **Step 2b: Run** the full test set (`test_hosted`, `test_store_admin`, `test_admin_auth`, `test_admin_api`, `test_admin_page`) — all pass.
- [ ] **Step 3: Vercel** (owner): set `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` (random 32+ chars) with the other env vars, deploy, open `https://<app>.vercel.app/admin`, repeat the create flow, `GET /health` still ok.
- [ ] **Step 4: Commit** `docs: admin panel setup`.
