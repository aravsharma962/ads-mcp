"""Hosted (HTTP) MCP server, multi-tenant. Vercel par chalta hai.

Flow: Authorization: Bearer <API key> -> tenant pata chalta hai -> tool sirf us tenant ke accounts dekhta hai.
Tenant kabhi tool ke argument se nahi aata.
"""
import json
import os

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from ads_api import MetaError, get_meta_campaigns
from store import get_store
from targets import check_campaign
from tenancy import current_tenant, reset_current, set_current

# Host check band: hum Host header par nahi, API key par bharosa karte hain.
mcp = FastMCP(
    "ads-manager-hosted",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


def _norm_account(external_id: str) -> str:
    external_id = external_id.strip()
    return external_id if external_id.startswith("act_") else f"act_{external_id}"


def _meta_rows(tool: str, external_id: str, date_preset: str):
    """Common raasta: ownership check + audit + Meta call. (rows, None) ya (None, error_dict)."""
    tenant = current_tenant()
    store = get_store()
    account = _norm_account(external_id)
    args = {"external_id": account, "date_preset": date_preset}

    token = store.get_token(tenant.id, "meta", account)
    if token is None:
        store.log_audit(tenant.id, tenant.key_label, tool, args, "denied")
        # Wahi message chahe account exist kare ya na kare, taaki doosre tenants ke IDs ka pata na chale.
        return None, {"error": "Is account par aapka access nahi hai."}
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
    return accounts or {"message": "Abhi koi ad account juda nahi hai."}


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
    return rows or {"message": "Is period mein koi campaign data nahi mila (spend 0 ho sakta hai)."}


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
        return {"message": "Is period mein koi campaign data nahi mila (spend 0 ho sakta hai)."}
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
        if scope["path"] == "/health":
            return await self._json(send, 200, {"status": "ok"})

        auth = dict(scope["headers"]).get(b"authorization", b"").decode()
        key = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        tenant = await anyio.to_thread.run_sync(get_store().resolve_api_key, key) if key else None
        if tenant is None:
            return await self._json(send, 401, {"error": "Invalid or missing API key"})

        ctx = set_current(tenant)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_current(ctx)


app = TenantAuth(mcp.streamable_http_app())
