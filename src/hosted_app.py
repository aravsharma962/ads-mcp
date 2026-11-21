"""Hosted (HTTP) MCP server, multi-tenant. Vercel par chalta hai.

Flow: Authorization: Bearer <API key> -> tenant pata chalta hai -> tool sirf us tenant ke accounts dekhta hai.
Tenant kabhi tool ke argument se nahi aata.
"""
import json
import os

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

import admin_app
import admin_auth
import internal_api
import contextvars

from ads_api import MetaError, get_meta_campaigns, get_meta_insights, raise_budget, set_object_status
from performance import DENIED, performance_for_client
from store import get_store
from targets import check_campaign
from tenancy import current_tenant, norm_account, reset_current, set_current

# Write tools sirf tab chalte hain jab internal_api.tools_call ise True kare. Default False: public /mcp par kabhi nahi.
writes_allowed: contextvars.ContextVar[bool] = contextvars.ContextVar("writes_allowed", default=False)

# Write tools alag FastMCP instance mein: public /mcp (mcp.streamable_http_app) ko ye dikhte hi nahi.
# Sirf internal_api inhe list/call karta hai.
write_mcp = FastMCP("ads-manager-writes")

# Host check band: hum Host header par nahi, API key par bharosa karte hain.
mcp = FastMCP(
    "ads-manager-hosted",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)




def _meta_rows(tool: str, external_id: str, date_preset: str):
    """Common raasta: ownership check + audit + Meta call. (rows, None) ya (None, error_dict)."""
    tenant = current_tenant()
    store = get_store()
    account = norm_account(external_id)
    args = {"external_id": account, "date_preset": date_preset}

    token = store.get_token(tenant.id, "meta", account)
    if token is None:
        store.log_audit(tenant.id, tenant.key_label, tool, args, "denied")
        # Wahi message chahe account exist kare ya na kare, taaki doosre tenants ke IDs ka pata na chale.
        return None, {"error": "You do not have access to this account."}
    try:
        rows = get_meta_campaigns(date_preset, token=token, account=account)
    except MetaError as e:
        store.log_audit(tenant.id, tenant.key_label, tool, args, "error")
        return None, {"error": str(e)}
    store.log_audit(tenant.id, tenant.key_label, tool, args, "ok")
    return rows, None


@mcp.tool()
def list_my_accounts() -> list[dict] | dict:
    """Aapke jode hue ad accounts ki list (platform aur account ID). Pehle isse dekho, phir baaki tools chalao."""
    tenant = current_tenant()
    store = get_store()
    accounts = store.list_connections(tenant.id)
    store.log_audit(tenant.id, tenant.key_label, "list_my_accounts", {}, "ok")
    return accounts or {"message": "No ad account is connected yet."}


@mcp.tool()
def meta_campaign_insights(external_id: str, date_preset: str = "last_7d") -> list[dict] | dict:
    """Ek Meta ad account ke campaigns ka performance: spend, impressions, clicks, CTR %, CPC, CPM, ROAS.

    external_id: ad account ID (list_my_accounts se), jaise act_1234567890.
    date_preset: today, yesterday, last_7d, last_14d, last_30d, this_month, last_month.
    Sirf padhta hai, kuch badalta nahi.
    """
    rows, err = _meta_rows("meta_campaign_insights", external_id, date_preset)
    if err:
        return err
    return rows or {"message": "No campaign data found for this period (spend may be 0)."}


@mcp.tool()
def meta_ads_insights(external_id: str, date_from: str, date_to: str, level: str = "campaign") -> dict:
    """Detailed performance of one Meta ad account at campaign, adset or ad level for a date range.

    external_id: ad account ID (from list_my_accounts). date_from/date_to: YYYY-MM-DD.
    level: campaign, adset or ad. Rows contain spend, impressions, link_clicks, landing_page_views,
    add_to_cart, purchases, purchase_value and ctr/cpc/cpm/roas (null when the denominator is 0).
    Read-only: changes nothing.
    """
    tenant = current_tenant()
    store = get_store()
    account = norm_account(external_id)
    args = {"external_id": account, "date_from": date_from, "date_to": date_to, "level": level}
    token = store.get_token(tenant.id, "meta", account)
    if token is None:
        store.log_audit(tenant.id, tenant.key_label, "meta_ads_insights", args, "denied")
        return {"error": "You do not have access to this account."}
    try:
        out = get_meta_insights(date_from, date_to, level, token=token, account=account)
    except MetaError as e:
        store.log_audit(tenant.id, tenant.key_label, "meta_ads_insights", args, "error")
        return {"error": str(e)}
    store.log_audit(tenant.id, tenant.key_label, "meta_ads_insights", args, "ok")
    return out


NOT_AVAILABLE = "Write tools are not available on this connection."
NOT_ENABLED = "Changes in Meta are not enabled on this platform."
WRITE_LEVELS = {"ad", "adset", "campaign"}


def _write_call(tool: str, args: dict, level: str, external_id: str, fn):
    """Write tools ka common raasta. Gates: internal API (ContextVar) -> ENABLE_META_WRITES=1 -> tenant ka account
    -> input check -> Meta call. Har call audit hota hai. fn(token, account) -> {"before","after"}."""
    tenant = current_tenant()
    store = get_store()

    def done(result: str, out: dict):
        store.log_audit(tenant.id, tenant.key_label, tool, args, result)
        return out

    if not writes_allowed.get():                       # public /mcp par hamesha False
        return done("denied", {"error": NOT_AVAILABLE})
    if os.environ.get("ENABLE_META_WRITES") != "1":
        return done("denied", {"error": NOT_ENABLED})
    if level not in WRITE_LEVELS:
        return done("denied", {"error": f"Invalid level. Choose one of: {sorted(WRITE_LEVELS)}"})
    account = norm_account(external_id)
    token = store.get_token(tenant.id, "meta", account)
    if token is None:
        return done("denied", {"error": "You do not have access to this account."})
    try:
        res = fn(token, account)
    except MetaError as e:
        msg = str(e)
        forbidden = msg.startswith(("forbidden", "Invalid", "unchanged"))
        return done("denied" if forbidden else "error", {"error": msg})
    return done("ok", {"ok": True, "object_id": args["object_id"], "level": level, **res})


@write_mcp.tool()
def meta_set_status(external_id: str, object_id: str, level: str, status: str) -> dict:
    """Pause or resume one Meta ad, ad set or campaign (changes the live account).

    external_id: ad account ID. object_id: the ad/adset/campaign ID. level: ad, adset or campaign.
    status: PAUSED or ACTIVE. Only available through the platform's internal API, never over MCP.
    """
    account = norm_account(external_id)
    args = {"external_id": account, "object_id": object_id, "level": level, "status": status}
    return _write_call("meta_set_status", args, level, external_id,
                       lambda token, acc: set_object_status(object_id, status, token, acc))


@write_mcp.tool()
def meta_raise_budget(external_id: str, object_id: str, level: str, percent: int) -> dict:
    """Raise the daily budget of one Meta ad set or campaign by 1 to 20 percent (changes the live account).

    external_id: ad account ID. object_id: the adset/campaign ID. level: adset or campaign. percent: whole
    number 1..20. Never lowers a budget, never touches lifetime budgets. Internal API only, never over MCP.
    """
    account = norm_account(external_id)
    args = {"external_id": account, "object_id": object_id, "level": level, "percent": percent}
    return _write_call("meta_raise_budget", args, level, external_id,
                       lambda token, acc: raise_budget(object_id, percent, token, acc))


@mcp.tool()
def ads_performance(client_id: str, date_from: str, date_to: str, level: str = "ad") -> dict:
    """Meta performance plus website tracking (sessions, add-to-cart, conversions) for one client.

    client_id: the agency's client ID. date_from/date_to: YYYY-MM-DD. level: campaign, adset or ad.
    Rows contain the Meta numbers plus sessions, add_to_cart_sessions, conversion_sessions, tracked_value,
    visit_rate, add_to_cart_rate, conversion_rate (against link clicks) and tracked_roas. Rates are null
    when the denominator is 0. 'unattributed' holds sessions not linked to any ad. Read-only.
    """
    tenant = current_tenant()
    store = get_store()
    args = {"client_id": client_id, "date_from": date_from, "date_to": date_to, "level": level}
    out = performance_for_client(store, tenant.id, client_id, date_from, date_to, level,
                                 lambda account: store.get_token(tenant.id, "meta", account))
    result = "ok"
    if "error" in out:
        result = "denied" if out == DENIED else "error"
    store.log_audit(tenant.id, tenant.key_label, "ads_performance", args, result)
    return out


@mcp.tool()
def meta_check_targets(external_id: str, date_preset: str = "last_7d") -> list[dict] | dict:
    """Ek Meta ad account ke campaigns ko targets (CTR, CPC, CPM, ROAS) se milata hai.

    Har campaign ke liye status: OK, MISS (kaunsa target miss hua) ya NO_DATA.
    Sirf padhta hai, kuch badalta nahi.
    """
    rows, err = _meta_rows("meta_check_targets", external_id, date_preset)
    if err:
        return err
    if not rows:
        return {"message": "No campaign data found for this period (spend may be 0)."}
    return [check_campaign(r) for r in rows]


class TenantAuth:
    """Pure ASGI middleware: har request par API key check, tenant context set."""

    def __init__(self, app):
        self.app = app

    async def _json(self, send, status: int, body: dict):
        data = json.dumps(body).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(data)).encode())]})
        await send({"type": "http.response.body", "body": data})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":          # lifespan etc.
            return await self.app(scope, receive, send)
        if scope["path"] == "/admin" or scope["path"].startswith("/admin/"):
            if not admin_auth.admin_enabled():                  # band hai to har /admin path 404
                return await self._json(send, 404, {"error": "Not found"})
            return await admin_app.app(scope, receive, send)   # apna password+cookie auth
        if scope["path"] == "/internal" or scope["path"].startswith("/internal/"):
            if not internal_api.service_enabled():              # secret set nahi to 404
                return await self._json(send, 404, {"error": "Not found"})
            return await internal_api.app(scope, receive, send)   # apna secret + tenant header auth
        if scope["path"] == "/health":
            return await self._json(send, 200, {"status": "ok"})

        auth = dict(scope["headers"]).get(b"authorization", b"").decode()
        key = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        tenant = await anyio.to_thread.run_sync(get_store().resolve_api_key, key) if key else None
        if tenant is None:
            return await self._json(send, 401, {"error": "Invalid or missing API key", "path": scope["path"]})

        ctx = set_current(tenant)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_current(ctx)


app = TenantAuth(mcp.streamable_http_app())
