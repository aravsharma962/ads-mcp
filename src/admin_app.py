"""Admin panel JSON API (Starlette). hosted_app.TenantAuth /admin* paths yahin bhejta hai.

Auth: ADMIN_PASSWORD -> signed cookie (admin_auth). Non-GET par X-Admin header zaroori (CSRF ke liye).
Raw API key sirf create-key response me aati hai; token kabhi kisi response me nahi.
"""
import os
import re
from pathlib import Path

import anyio
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route

import admin_auth
from store import get_store
from tenancy import norm_account

ACCOUNT_RE = re.compile(r"^act_\d{1,30}$")
PAGE = Path(__file__).with_name("admin_page.html")


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


async def _run(fn, *a):
    return await anyio.to_thread.run_sync(fn, *a)


async def _body(request: Request) -> dict | None:
    try:
        data = await request.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _s(data: dict, key: str) -> str:
    v = data.get(key)
    return v.strip() if isinstance(v, str) else ""


def _client_ip(request: Request) -> str:
    """Client ke bheje headers par bharosa nahi (spoof ho sakte hain). Vercel par uska apna header."""
    if os.environ.get("VERCEL"):
        v = request.headers.get("x-vercel-forwarded-for") or request.headers.get("x-real-ip")
        if v:
            return v.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _guard(request: Request) -> Response | None:
    """None = ok. Warna bani-banayi error response."""
    if not admin_auth.admin_enabled():
        return _err(404, "Not found")
    if request.method != "GET" and request.headers.get("x-admin") != "1":
        return _err(403, "Missing X-Admin header")
    if not admin_auth.verify_session(request.cookies.get("admin_session")):
        return _err(401, "Login required")
    return None


async def page(request: Request):
    if not admin_auth.admin_enabled():
        return _err(404, "Not found")
    return HTMLResponse(PAGE.read_text(encoding="utf-8"))


async def login(request: Request):
    if not admin_auth.admin_enabled():
        return _err(404, "Not found")
    if request.headers.get("x-admin") != "1":
        return _err(403, "Missing X-Admin header")
    ip = _client_ip(request)
    if not admin_auth.limiter.allowed(ip):
        return _err(429, "Bahut galat try. 15 minute baad dobara.")
    data = await _body(request) or {}
    if not admin_auth.check_password(data.get("password", "")):
        admin_auth.limiter.fail(ip)
        return _err(401, "Galat password")
    admin_auth.limiter.reset(ip)
    resp = JSONResponse({"ok": True})
    secure = request.url.hostname not in ("localhost", "127.0.0.1")
    resp.set_cookie("admin_session", admin_auth.make_session(), max_age=admin_auth.SESSION_SECONDS,
                    httponly=True, samesite="strict", secure=secure, path="/admin")
    return resp


async def logout(request: Request):
    bad = _guard(request)
    if bad:
        return bad
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("admin_session", path="/admin")
    return resp


async def tenants(request: Request):
    bad = _guard(request)
    if bad:
        return bad
    store = get_store()
    if request.method == "GET":
        return JSONResponse(await _run(store.list_tenants))
    name = _s(await _body(request) or {}, "name")
    if not name:
        return _err(400, "Agency ka naam chahiye")
    t = await _run(store.create_tenant, name)
    return JSONResponse({"id": t.id, "name": t.name, "plan": t.plan}, status_code=201)


async def tenant_detail(request: Request):
    bad = _guard(request)
    if bad:
        return bad
    store = get_store()
    tid = request.path_params["tid"]
    t = await _run(store.get_tenant, tid)
    if not t:
        return _err(404, "Tenant nahi mila")
    return JSONResponse({"tenant": t, "keys": await _run(store.list_keys, tid),
                         "connections": await _run(store.list_connections, tid)})


async def create_key(request: Request):
    bad = _guard(request)
    if bad:
        return bad
    store = get_store()
    tid = request.path_params["tid"]
    if not await _run(store.get_tenant, tid):
        return _err(404, "Tenant nahi mila")
    label = _s(await _body(request) or {}, "label") or "default"
    return JSONResponse({"key": await _run(store.create_api_key, tid, label)}, status_code=201)


async def revoke_key(request: Request):
    bad = _guard(request)
    if bad:
        return bad
    ok = await _run(get_store().revoke_key_by_id, request.path_params["tid"], request.path_params["kid"])
    return JSONResponse({"ok": True}) if ok else _err(404, "Key nahi mili")


async def add_connection(request: Request):
    bad = _guard(request)
    if bad:
        return bad
    store = get_store()
    tid = request.path_params["tid"]
    if not await _run(store.get_tenant, tid):
        return _err(404, "Tenant nahi mila")
    data = await _body(request) or {}
    account, token = _s(data, "account"), _s(data, "token")
    if not account or not token:
        return _err(400, "Account ID aur token dono chahiye")
    account = norm_account(account)
    if not ACCOUNT_RE.match(account):
        return _err(400, "Account ID galat hai (act_ ke baad sirf digits)")
    await _run(store.add_connection, tid, "meta", account, token)
    return JSONResponse({"external_id": account}, status_code=201)


async def remove_connection(request: Request):
    bad = _guard(request)
    if bad:
        return bad
    ok = await _run(get_store().delete_connection, request.path_params["tid"], "meta",
                    norm_account(request.path_params["external_id"]))
    return JSONResponse({"ok": True}) if ok else _err(404, "Account nahi mila")


class SecurityHeaders:
    """Har admin response par: no-store, nosniff, no-referrer, frame DENY."""

    HEADERS = [(b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff"),
               (b"referrer-policy", b"no-referrer"), (b"x-frame-options", b"DENY")]

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        async def wrapped(message):
            if message["type"] == "http.response.start":
                names = {k.lower() for k, _ in message["headers"]}
                message["headers"] = list(message["headers"]) + [h for h in self.HEADERS if h[0] not in names]
            await send(message)
        await self.app(scope, receive, wrapped if scope["type"] == "http" else send)


_routes = [
    Route("/admin", page, methods=["GET"]),
    Route("/admin/api/login", login, methods=["POST"]),
    Route("/admin/api/logout", logout, methods=["POST"]),
    Route("/admin/api/tenants", tenants, methods=["GET", "POST"]),
    Route("/admin/api/tenants/{tid}", tenant_detail, methods=["GET"]),
    Route("/admin/api/tenants/{tid}/keys", create_key, methods=["POST"]),
    Route("/admin/api/tenants/{tid}/keys/{kid}", revoke_key, methods=["DELETE"]),
    Route("/admin/api/tenants/{tid}/connections", add_connection, methods=["POST"]),
    Route("/admin/api/tenants/{tid}/connections/{external_id}", remove_connection, methods=["DELETE"]),
]
app = SecurityHeaders(Starlette(routes=_routes))
