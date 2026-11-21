# Deploying the SaaS platform

Two Vercel projects from this one repository:

| Project | Root directory | What it is |
|---|---|---|
| A: hub | repository root | Python MCP hub (`api/index.py`), Meta access, `ads_performance`, internal API |
| B: web | `web` | Next.js app: login, dashboard, AI assistant, tracker script, collector |

The browser only ever talks to B. B talks to A server-to-server with a shared secret. Meta tokens live only in the hub, encrypted.

## 1. Database

1. Supabase -> SQL Editor. If not done already, run `supabase/migrations/001_init.sql`.
2. Paste and run `supabase/migrations/002_saas.sql`. Success: the tables `memberships`, `clients`, `client_accounts`, `targets`, `conversations`, `messages`, `usage_events`, `insights_cache`, `sites`, `events` appear in Table Editor, each with RLS on.
2b. Run `supabase/migrations/003_saas_hardening.sql` (if not done), then `supabase/migrations/004_business_types.sql` **before** deploying the web app that has business types: it adds `clients.business_type` (existing clients become `ecommerce`). Success: `select business_type from clients` works.
3. Supabase -> Authentication -> Providers -> Email: turn **Allow new users to sign up** off (the platform is invite-only).
4. Supabase -> Authentication -> URL Configuration: set Site URL to the web app URL (`APP_URL`).

## 2. Shared secret

Generate once and use the same value in both projects:

```
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Treat it like a password. If it leaks, replace it in both projects and redeploy both.

## 3. Hub (project A)

Existing hub variables stay as they are (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENC_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`). Add:

| Variable | Value |
|---|---|
| `HUB_SERVICE_SECRET` | the shared secret from step 2 |

Redeploy. Without this variable the hub's `/internal/*` API answers 404, so the web app cannot reach it.

## 4. Web app (project B)

Create a new Vercel project from the same repository, **Root Directory = `web`**. Build command is the default (`npm run build`, which also builds `public/t.js`). Environment variables:

| Variable | Where the value comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase -> Project Settings -> API -> Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page, `anon` `public` key (safe in the browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, `service_role` key. Secret. Server only |
| `HUB_URL` | URL of project A, for example `https://your-hub.vercel.app` |
| `HUB_SERVICE_SECRET` | the shared secret from step 2 (identical to project A) |
| `ANTHROPIC_API_KEY` | Anthropic console -> API keys (needed when `AI_PROVIDER=claude`) |
| `OPENAI_API_KEY` | OpenAI dashboard (only if `AI_PROVIDER=openai`) |
| `AI_PROVIDER` | `claude` (default) or `openai` |
| `AI_MODEL_CLAUDE` / `AI_MODEL_OPENAI` | the model id you want to use, from the provider's model list |
| `AI_MONTHLY_TOKEN_CAP` | tokens per agency per month, default `200000` |
| `APP_URL` | the public URL of project B, no trailing slash |

Only the two `NEXT_PUBLIC_` values are exposed to browsers. Never put a secret in a variable with that prefix.

## 5. First agency and owner

The platform has no signup page. Create the first owner by hand:

1. Create the agency: in the hub admin panel (`<hub-url>/admin`) create a tenant, or insert a row into `tenants` (name). Copy its `id`.
2. Supabase -> Authentication -> Users -> **Invite user**, enter the owner's email. The owner follows the email link and sets a password.
3. SQL Editor, using the new user's id and the tenant id:
   ```sql
   insert into memberships (user_id, tenant_id, role) values ('<auth user id>', '<tenant id>', 'owner');
   ```
4. The owner signs in at `<APP_URL>/login`. Further teammates are invited from Settings -> Team (members can view and edit targets and use the assistant; only owners create clients, connect accounts and set up tracking).

## 6. Tracking on a client website

1. In the app: Client -> Tracking -> enter the website address(es) (for example `https://www.client-site.com`) -> **Create tracking site**. Only these origins may send events; add every address the site uses (with and without `www`, staging if needed).
2. Paste the shown `<script async src="https://<APP_URL>/t.js" data-site-key="sk_..."></script>` into every page of the client's site.
3. In Meta Ads Manager add these URL parameters to every ad: `utm_source=facebook&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`.
4. If the site needs a cookie banner, add `data-consent="manual"` to the script tag and call `adsTrack.consent()` after the visitor agrees. The agency and its client are responsible for consent and privacy-law compliance (for example India's DPDP Act).
5. For custom events call `adsTrack("add_to_cart")` or `adsTrack("purchase", {value: 499, currency: "INR"})`. Allowed event names: `page_view`, `add_to_cart`, `form_submit`, `purchase`. Form submissions are detected automatically and never send field values.

The collector never stores IP addresses, and rejects any payload with personal-data fields (`email`, `phone`, `name`). Rotating the site key (Tracking page) stops the old snippet from working.

**The origin check is not authentication.** The site key is public (it sits in the page source) and the `Origin` header is only enforced by browsers; a script or server can send any `Origin` it likes. So the collector treats its data as untrusted: events are limited per site (1200 per minute), per visitor address per site (120 per minute, keyed by a salted hash held only in memory, never stored) and per session (60 per minute); purchase values above 10,000,000 are rejected; bodies over 4 KB are cut off while being read. These limits reduce abuse but cannot stop a determined forger, so tracked ROAS is a signal, not an audited figure. Rotate the site key if you see junk traffic.

## 7. Smoke test

- [ ] `<APP_URL>/login` signs the owner in; an unknown email cannot sign up.
- [ ] Create a client (currency and timezone set).
- [ ] Accounts tab: connect a Meta ad account with a system-user token (`ads_read`). A currency different from the client's is rejected.
- [ ] Dashboard loads with spend, impressions, clicks and status badges.
- [ ] Assistant answers a question such as "Which ads are off target this week?" and shows which tools it used.
- [ ] Tracking tab: after loading the client's site with the ad URL parameters, an event arrives (Tracking health shows events in the last 24 hours).
- [ ] A user of a second agency cannot open the first agency's client URL (they get "not found").
- [ ] `<HUB_URL>/internal/accounts` without headers answers 401, not data.

## 8. Notes

- Rate limits (collector: 60 events per minute per site key and session, 120 per visitor address, 1200 per site; assistant: 20 messages per minute per agency) are held in memory per serverless instance, so they limit bursts rather than giving exact global quotas.
- Tracked numbers differ from Meta Ads Manager (ad blockers, missing URL parameters, consent choices). The Tracking page says so.
- The MVP is read-only on Meta (`ads_read`).

## Phase A (Actions, Report, Site pages, Leads)

Order matters:
1. Run `supabase/migrations/005_actions.sql` in the Supabase SQL editor (adds `clients.action_rules` and the `lead_marks` table).
2. Deploy the hub (Vercel project for the repo root): it now returns `frequency` and `reach`, and ignores `page_leave` events.
3. Deploy the web app (Vercel project with root directory `web`). `public/t.js` is rebuilt by `npm run build`; sites using the snippet pick up bounce tracking automatically (browsers may cache the old file for a while).
4. `git add -f web/src/lib` (the local .gitignore ignores `lib/`).

## Phase 2A (approve and apply to Meta)

Writes are OFF by default. Order:
1. Run `supabase/migrations/006_action_log.sql` in the Supabase SQL editor.
2. Deploy hub and web (push to GitHub).
3. To turn writes on set BOTH env vars and redeploy: hub `ENABLE_META_WRITES=1`, web `META_WRITES_ENABLED=1`.
4. The connected Meta token must have the `ads_management` permission. With a read-only token the platform shows a "permission" message and changes nothing.
5. Test first on your own ad account with one test ad.
