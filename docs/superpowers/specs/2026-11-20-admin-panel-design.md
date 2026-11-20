# Admin panel (Option A) - design

Why: `scripts/admin.py` terminal se chalta hai; owner browser se tenants, API keys aur Meta accounts manage karna chahta hai.

## Approaches
- A (picked): single-password admin page `/admin` in existing ASGI app. Fast, no new framework.
- B: per-agency login (Supabase Auth + Next.js + RLS). Later, jab agencies self-signup maangein.

## Goals
- Create tenant, list tenants; create API key (shown once); add Meta account + token (encrypted server-side); list keys/accounts (never tokens); revoke key; remove account.
- Single HTML file + vanilla JS, no build step.

## Non-goals
Agency login, billing, Google Ads.

## Security (my calls)
- ADMIN_PASSWORD env var; /admin disabled when unset.
- Signed HttpOnly SameSite=Strict cookie; constant-time compare; login rate limit.
- /admin separate from /mcp Bearer path; responses never contain tokens or raw keys (except key once at creation).

## Builder decides
store.py may need list_tenants / list_keys / revoke / delete_connection methods (memory + Supabase stores).

## Tests
No login -> denied; wrong password -> denied; login -> create tenant/key/account; key works on /mcp; no token/raw key in any other response. Then manual browser check locally, then Vercel.
