"""Hub internal REST API (/internal/*). Sirf hamari web app (server-to-server) ke liye.

Auth: X-Hub-Secret (HUB_SERVICE_SECRET) AUR X-Tenant-Id dono zaroori. Tenant yahan sirf tabhi mana jaata
hai jab secret sahi ho; public routes X-Tenant-Id ko kabhi nahi dekhte. Token kabhi kisi response me nahi.
"""
import hmac
import json
import os
import sys
import traceback
import uuid

import anyio
from mcp.server.fastmcp.exceptions import ToolError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from admin_app import ACCOUNT_RE, SecurityHeaders, redact
from store import get_store
from tenancy import Tenant, norm_account, reset_current, set_current


def service_enabled() -> bool:
    return bool(os.environ.get("HUB_SERVICE_SECRET", ""))


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


async def _run(fn, *a):
    return await anyio.to_thread.run_sync(fn, *a)


async def _authenticate(request: Request) -> Tenant | Response:
    """Tenant ya error response. Pehle secret, phir tenant header, phir tenant exist."""
    secret = os.environ.get("HUB_SERVICE_SECRET", "")
    if not secret:
        return _err(404, "Not found")
    given = request.headers.get("x-hub-secret", "")
    if not hmac.compare_digest(given.encode(), secret.encode()):
        return _err(401, "Invalid or missing service secret")
    tid = request.headers.get("x-tenant-id", "").strip()
    if not tid:
        return _err(400, "X-Tenant-Id header required")
    try:
        tid = str(uuid.UUID(tid))
    except ValueError:
        return _err(403, "Unknown tenant")
    t = await _run(get_store().get_tenant, tid)
    if not t:
        return _err(403, "Unknown tenant")
    return Tenant(t["id"], t["name"], t["plan"], "web")


def _guarded(handler):
    async def wrapper(request: Request):
        tenant = await _authenticate(request)
        if isinstance(tenant, Response):
            return tenant
        return await handler(request, tenant)
    return wrapper


async def _json_body(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _s(data: dict, key: str) -> str:
    v = data.get(key)
    return v.strip() if isinstance(v, str) else ""


@_guarded
async def accounts(request: Request, tenant: Tenant):
    store = get_store()
    if request.method == "GET":
        return JSONResponse(await _run(store.list_connections, tenant.id))
    data = await _json_body(request)
    account, token = _s(data, "account"), _s(data, "token")
    if not account or not token:
        return _err(400, "Account ID and token are both required")
    account = norm_account(account)
    if not ACCOUNT_RE.match(account):
        return _err(400, "Invalid account ID (digits only after act_)")
    await _run(store.add_connection, tenant.id, "meta", account, token)
    return JSONResponse({"external_id": account}, status_code=201)


@_guarded
async def account_delete(request: Request, tenant: Tenant):
    ok = await _run(get_store().delete_connection, tenant.id, "meta",
                    norm_account(request.path_params["external_id"]))
    return JSONResponse({"ok": True}) if ok else _err(404, "Account not found")


@_guarded
async def tools_list(request: Request, tenant: Tenant):
    from hosted_app import mcp          # late import: hosted_app imports this module
    tools = await mcp.list_tools()
    return JSONResponse([{"name": t.name, "description": t.description or "", "input_schema": t.inputSchema}
                         for t in tools])


def _unwrap(out):
    """FastMCP call_tool ka output -> plain tool result."""
    structured = None
    content = out
    if isinstance(out, tuple):
        content, structured = out
    elif isinstance(out, dict):
        structured = out
    if isinstance(structured, dict):
        return structured["result"] if set(structured) == {"result"} else structured
    texts = [getattr(c, "text", "") for c in (content or [])]
    if len(texts) == 1:
        try:
            return json.loads(texts[0])
        except ValueError:
            return texts[0]
    return [json.loads(t) if t[:1] in "{[" else t for t in texts]


@_guarded
async def tools_call(request: Request, tenant: Tenant):
    from hosted_app import mcp
    data = await _json_body(request)
    name = _s(data, "name")
    args = data.get("arguments") or {}
    if not name or not isinstance(args, dict):
        return _err(400, "name and arguments (object) required")
    if name not in {t.name for t in await mcp.list_tools()}:
        return _err(404, "Unknown tool")
    ctx = set_current(tenant)                       # tool isi tenant ke naam se chalta hai
    try:
        out = await mcp.call_tool(name, args)
    except ToolError as e:
        return _err(400, redact(str(e))[:500])
    except Exception as e:
        print(redact("".join(traceback.format_exception(e))), file=sys.stderr)
        return _err(500, "Tool failed")
    finally:
        reset_current(ctx)
    return JSONResponse({"result": _unwrap(out)})


async def on_error(request: Request, exc: Exception):
    print(redact("".join(traceback.format_exception(exc))), file=sys.stderr)
    return _err(500, "Server error")


_routes = [
    Route("/internal/accounts", accounts, methods=["GET", "POST"]),
    Route("/internal/accounts/{external_id}", account_delete, methods=["DELETE"]),
    Route("/internal/tools", tools_list, methods=["GET"]),
    Route("/internal/tools/call", tools_call, methods=["POST"]),
]
app = SecurityHeaders(Starlette(routes=_routes, exception_handlers={Exception: on_error}))
