"""Hub /internal/* API. Chalane ka: python tests/test_internal_api.py"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()
os.environ.pop("HUB_SERVICE_SECRET", None)

from starlette.testclient import TestClient  # noqa: E402
import hosted_app  # noqa: E402
from store import get_store  # noqa: E402

SECRET = "hub-secret-for-tests-0123456789abcdef"
store = get_store()
A = store.create_tenant("A"); B = store.create_tenant("B")
TOKEN_A, TOKEN_B = "TOKEN_A_VERY_SECRET_123", "TOKEN_B_VERY_SECRET_456"
responses = []     # test_no_token_in_any_response ke liye


def H(tenant=None, secret=SECRET):
    h = {}
    if secret is not None:
        h["X-Hub-Secret"] = secret
    if tenant is not None:
        h["X-Tenant-Id"] = tenant.id if hasattr(tenant, "id") else tenant
    return h


def req(c, method, path, **kw):
    r = c.request(method, path, **kw)
    responses.append(r.text + json.dumps(dict(r.headers)))
    return r


c = TestClient(hosted_app.app)


def test_disabled_without_secret_404():
    os.environ.pop("HUB_SERVICE_SECRET", None)
    for p in ("/internal/accounts", "/internal/tools"):
        assert req(c, "GET", p, headers=H(A)).status_code == 404
    assert req(c, "POST", "/internal/tools/call", headers=H(A), json={"name": "x"}).status_code == 404
    os.environ["HUB_SERVICE_SECRET"] = ""
    assert req(c, "GET", "/internal/accounts", headers=H(A, "")).status_code == 404
    os.environ["HUB_SERVICE_SECRET"] = SECRET


def test_missing_or_wrong_secret_401():
    os.environ["HUB_SERVICE_SECRET"] = SECRET
    assert req(c, "GET", "/internal/accounts", headers=H(A, None)).status_code == 401   # sirf tenant header
    assert req(c, "GET", "/internal/accounts", headers=H(A, "wrong")).status_code == 401
    assert req(c, "GET", "/internal/accounts", headers=H(None, "wrong")).status_code == 401
    assert req(c, "GET", "/internal/accounts").status_code == 401
    assert req(c, "GET", "/internal/accounts", headers={"Authorization": "Bearer x", "X-Tenant-Id": A.id}).status_code == 401


def test_secret_without_tenant_header_400():
    assert req(c, "GET", "/internal/accounts", headers=H(None)).status_code == 400
    assert req(c, "GET", "/internal/accounts", headers=H("")).status_code == 400


def test_unknown_tenant_403():
    assert req(c, "GET", "/internal/accounts", headers=H("00000000-0000-0000-0000-000000000000")).status_code == 403
    assert req(c, "GET", "/internal/accounts", headers=H("not-a-uuid")).status_code == 403


def test_public_routes_ignore_x_tenant_id():
    with TestClient(hosted_app.app) as c2:
        r = c2.post("/mcp", headers={"X-Tenant-Id": A.id, "X-Hub-Secret": SECRET,
                                     "Accept": "application/json, text/event-stream",
                                     "Content-Type": "application/json"},
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401
        r = c2.get("/admin/api/tenants", headers={"X-Tenant-Id": A.id, "X-Hub-Secret": SECRET})
        assert r.status_code in (401, 404)          # admin ka apna auth, tenant header se farak nahi
        assert c2.get("/health", headers={"X-Tenant-Id": A.id}).json() == {"status": "ok"}


def test_accounts_crud_isolated_per_tenant():
    r = req(c, "POST", "/internal/accounts", headers=H(A), json={"account": "1", "token": TOKEN_A})
    assert r.status_code == 201 and r.json() == {"external_id": "act_1"}
    assert req(c, "GET", "/internal/accounts", headers=H(A)).json() == [{"platform": "meta", "external_id": "act_1"}]
    assert req(c, "GET", "/internal/accounts", headers=H(B)).json() == []
    assert req(c, "DELETE", "/internal/accounts/act_1", headers=H(B)).status_code == 404
    assert req(c, "GET", "/internal/accounts", headers=H(A)).json() == [{"platform": "meta", "external_id": "act_1"}]
    assert store.get_token(B.id, "meta", "act_1") is None
    req(c, "POST", "/internal/accounts", headers=H(B), json={"account": "act_2", "token": TOKEN_B})
    assert req(c, "DELETE", "/internal/accounts/2", headers=H(A)).status_code == 404
    assert req(c, "DELETE", "/internal/accounts/act_2", headers=H(B)).status_code == 200
    assert req(c, "DELETE", "/internal/accounts/act_2", headers=H(B)).status_code == 404
    store.add_connection(B.id, "meta", "act_2", TOKEN_B)


def test_add_account_rejects_bad_id_and_blank_token():
    for body in ({"account": "abc", "token": "t"}, {"account": "act_1; drop", "token": "t"},
                 {"account": "act_5", "token": "   "}, {"account": "", "token": "t"}, {"token": "t"}, {}):
        assert req(c, "POST", "/internal/accounts", headers=H(A), json=body).status_code == 400, body
    assert req(c, "POST", "/internal/accounts", headers=H(A), data="not json").status_code == 400
    assert [x["external_id"] for x in store.list_connections(A.id)] == ["act_1"]


def test_tools_list_has_schemas():
    r = req(c, "GET", "/internal/tools", headers=H(A))
    tools = {t["name"]: t for t in r.json()}
    assert {"list_my_accounts", "meta_campaign_insights", "meta_ads_insights", "meta_check_targets"} <= set(tools)
    for t in tools.values():
        assert set(t) == {"name", "description", "input_schema"} and isinstance(t["input_schema"], dict)
        assert "tenant" not in json.dumps(t["input_schema"])


def test_tools_call_runs_as_that_tenant():
    ra = req(c, "POST", "/internal/tools/call", headers=H(A), json={"name": "list_my_accounts", "arguments": {}})
    rb = req(c, "POST", "/internal/tools/call", headers=H(B), json={"name": "list_my_accounts", "arguments": {}})
    assert ra.status_code == 200 and rb.status_code == 200
    assert ra.json() == {"result": [{"platform": "meta", "external_id": "act_1"}]}, ra.json()
    assert rb.json() == {"result": [{"platform": "meta", "external_id": "act_2"}]}, rb.json()
    # dict-returning tool + foreign account denial
    rd = req(c, "POST", "/internal/tools/call", headers=H(A),
             json={"name": "meta_ads_insights", "arguments": {"external_id": "act_2", "date_from": "2026-11-01",
                                                               "date_to": "2026-11-02"}})
    assert rd.json() == {"result": {"error": "You do not have access to this account."}}, rd.json()


def test_tool_schemas_match_web_contract():
    """web/src/lib/chat.ts + performance route call these tools with exactly these argument names and levels."""
    tools = {t["name"]: t for t in req(c, "GET", "/internal/tools", headers=H(A)).json()}
    ins = tools["meta_ads_insights"]["input_schema"]["properties"]
    perf = tools["ads_performance"]["input_schema"]["properties"]
    assert {"external_id", "date_from", "date_to", "level"} <= set(ins), ins
    assert {"client_id", "date_from", "date_to", "level"} <= set(perf), perf
    from ads_api import VALID_LEVELS
    assert VALID_LEVELS == {"campaign", "adset", "ad"}    # web LEVELS in lib/performance.ts


def test_tools_call_unknown_tool_404():
    r = req(c, "POST", "/internal/tools/call", headers=H(A), json={"name": "nope", "arguments": {}})
    assert r.status_code == 404
    assert req(c, "POST", "/internal/tools/call", headers=H(A), json={"arguments": {}}).status_code == 400
    r = req(c, "POST", "/internal/tools/call", headers=H(A),
            json={"name": "meta_ads_insights", "arguments": {"bogus": 1}})
    assert r.status_code == 400 and "error" in r.json()


def test_security_headers_and_method_guard():
    r = req(c, "GET", "/internal/accounts", headers=H(A))
    assert r.headers["cache-control"] == "no-store" and r.headers["x-content-type-options"] == "nosniff"
    assert req(c, "PUT", "/internal/accounts", headers=H(A)).status_code == 405
    assert req(c, "GET", "/internal/nothing", headers=H(A)).status_code == 404


def test_no_token_in_any_response():
    blob = "\n".join(responses)
    assert TOKEN_A not in blob and TOKEN_B not in blob and SECRET not in blob


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
