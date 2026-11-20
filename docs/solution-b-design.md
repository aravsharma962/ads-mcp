# Solution B: White-label multi-tenant Ads MCP (design)

## Goal
Agencies ko ek hosted MCP URL + API key do. Har agency sirf apne Meta (baad me Google) ad accounts dekhe. Tumhara tool = Claude/ChatGPT ke andar ads analysis.

## Architecture
Claude/any MCP client --(HTTPS, Bearer agency-key)--> Vercel (api/index.py, ASGI)
  -> TenantAuth: key SHA-256 hash -> tenant (Supabase)
  -> tools: list_my_accounts, meta_campaign_insights, meta_check_targets
  -> store.get_token(tenant, "meta", account): Fernet-decrypted token, ownership check
  -> Meta Graph API v27.0
  -> audit_log row har call par.

## Isolation rules (tested in tests/test_hosted.py)
1. tenant_id kabhi tool argument nahi; sirf authenticated key se.
2. Account ownership check; denial message same (account exist karta hai ya nahi, leak nahi).
3. Tokens Fernet-encrypted at rest; API key sirf hash.
4. Revoked key -> 401.
5. Audit log: ok / denied / error.

## Supabase setup
1. New project -> SQL editor -> supabase/migrations/001_init.sql run karo.
2. Settings -> API: Project URL + service_role key copy karo (service_role kabhi browser/frontend me nahi).
3. TOKEN_ENC_KEY generate: python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"

## Vercel deploy
1. Repo import (Private repo pehle karo). Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY, ADMIN_PASSWORD, ADMIN_SESSION_SECRET (random 32+ chars).
   Note: ADMIN_PASSWORD kam se kam 16 characters ka strong rakho (chhota ho to /admin band rahega), kyunki /admin page saare tenants ke tokens control karta hai.
   Note: naye Supabase projects me grants chahiye; woh lines supabase/migrations/001_init.sql me already append hain.
2. Deploy, phir GET /health aur ek MCP initialize call se test karo.
3. Hobby plan non-commercial hai: agencies se paise lene se pehle Vercel Pro.

## Agency onboarding
Primary: browser me https://<app>.vercel.app/admin kholo, ADMIN_PASSWORD se login karo. Wahan: agency create karo, API key create karo (sirf ek baar dikhti hai), Meta account (act_...) + token add karo.

Fallback CLI (scripts/admin.py):
python scripts/admin.py create-tenant "Agency X"
python scripts/admin.py create-key <tenant_id> [label]   # key sirf ek baar dikhti hai
python scripts/admin.py add-meta <tenant_id> act_123      # token ke liye prompt aata hai
python scripts/admin.py list <tenant_id>
Agency Claude me connector add kare: https://<app>.vercel.app/mcp + header Authorization: Bearer <key>

## Risks / untested
- Vercel par streamable-http lifespan/session behavior untested -> pehle deploy karke ping test.
- SupabaseStore real Supabase par untested (tests in-memory store par).
- Meta: doosron ke accounts ke liye App Review / Tech Provider chahiye; abhi har agency apna system-user token deti hai.
- Rate limiting nahi hai; tools sync/blocking hain.
- Write tools (pause/budget) abhi nahi; aayenge to approval flow zaroori.

## Phases
1. (done) Backend + isolation tests.
2. Supabase + Vercel deploy, real test.
3. Dashboard: Next.js on Vercel, Supabase Auth, per-tenant RLS policies (agencies keys/accounts manage, usage dekhein).
4. Meta OAuth onboarding (token paste ki jagah).
5. Google Ads tools (Developer Token chahiye, abhi apply karo).
6. Rate limits, billing/plans, write tools with approval.

## Admin panel notes
- Logout cookie client se hatata hai; session stateless hai, isliye chori hui cookie 8h tak chalti hai. Turant band karna ho to ADMIN_SESSION_SECRET badal do.
- Login rate limit: 5 galat/IP/15 min, aur sab IP milakar 50. Serverless me har instance ka apna count hai (best-effort). Attack me asli admin bhi 15 min lock ho sakta hai.
