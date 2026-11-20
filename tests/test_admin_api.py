"""Admin JSON API + mount. Chalane ka: python tests/test_admin_api.py"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()
os.environ["ADMIN_PASSWORD"] = "pw-test-long-enough-123"

from starlette.testclient import TestClient  # noqa: E402
import admin_auth  # noqa: E402
import hosted_app  # noqa: E402
from store import get_store  # noqa: E402

X = {"X-Admin": "1"}
MCP_HDR = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
SEEN: list[str] = []     # har response ka body, leak check ke liye


def req(c, method, path, **kw):
    r = c.request(method, path, **kw)
    SEEN.append(r.text)
    return r


def login(c, pw="pw-test-long-enough-123"):
    return req(c, "POST", "/admin/api/login", json={"password": pw}, headers=X)


def mcp_list_accounts(c, key):
    h = dict(MCP_HDR)
    h["Authorization"] = f"Bearer {key}"
    r = c.post("/mcp", headers=h, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                        "params": {"name": "list_my_accounts", "arguments": {}}})
    return r


def main():
    store = get_store()
    with TestClient(hosted_app.app, base_url="http://localhost") as c:
        # --- disabled ---
        os.environ["ADMIN_PASSWORD"] = ""
        for m, p in [("GET", "/admin"), ("GET", "/admin/api/tenants"), ("POST", "/admin/api/login")]:
            assert req(c, m, p, headers=X).status_code == 404, p
        for m, p in [("GET", "/admin/"), ("PUT", "/admin/api/tenants"), ("OPTIONS", "/admin/api/login"),
                     ("GET", "/admin/api/tenants/x/keys"), ("GET", "/admin/anything")]:
            assert req(c, m, p, headers=X).status_code == 404, (m, p)
        os.environ["ADMIN_PASSWORD"] = "short"                       # bahut chhota = disabled
        assert req(c, "GET", "/admin").status_code == 404
        os.environ["ADMIN_PASSWORD"] = "pw-test-long-enough-123"
        print("OK  password unset -> /admin* 404")

        # --- no cookie ---
        assert req(c, "GET", "/admin/api/tenants").status_code == 401
        print("OK  cookie ke bina 401")

        # --- login ---
        assert login(c, "wrong").status_code == 401
        assert req(c, "POST", "/admin/api/login", json={"password": "pw-test-long-enough-123"}).status_code == 403  # X-Admin nahi
        for _ in range(4):
            assert login(c, "wrong").status_code == 401
        assert login(c, "pw-test-long-enough-123").status_code == 429          # 5 fails ke baad sahi password bhi rok diya
        admin_auth.limiter.reset("testclient")
        r = login(c)
        assert r.status_code == 200 and "admin_session" in c.cookies
        sc = r.headers["set-cookie"].lower()
        assert "httponly" in sc and "samesite=strict" in sc
        print("OK  login: wrong 401, X-Admin 403, rate limit 429, sahi 200 + cookie flags")

        # --- spoofed X-Forwarded-For se limit bypass nahi ---
        admin_auth.limiter.reset("testclient"); c.cookies.clear()
        codes = [req(c, "POST", "/admin/api/login", json={"password": "bad"},
                     headers={**X, "X-Forwarded-For": f"6.6.6.{i}"}).status_code for i in range(7)]
        assert codes[:5] == [401] * 5 and codes[5:] == [429, 429], codes
        admin_auth.limiter.reset("testclient"); login(c)
        print("OK  X-Forwarded-For badalne se rate limit nahi tootta")

        # --- security headers ---
        for r in (req(c, "GET", "/admin"), req(c, "GET", "/admin/api/tenants"), login(c)):
            h = r.headers
            assert h.get("cache-control") == "no-store" and h.get("x-content-type-options") == "nosniff"
            assert h.get("x-frame-options") == "DENY" and h.get("referrer-policy") == "no-referrer"
        print("OK  admin responses par security headers")

        # --- CSRF header ---
        assert req(c, "POST", "/admin/api/tenants", json={"name": "No Header"}).status_code == 403
        print("OK  POST bina X-Admin 403")

        # --- full flow ---
        r = req(c, "POST", "/admin/api/tenants", json={"name": "Flow Agency"}, headers=X)
        assert r.status_code == 201, r.text
        tid = r.json()["id"]
        assert any(t["id"] == tid for t in req(c, "GET", "/admin/api/tenants").json())
        r = req(c, "POST", f"/admin/api/tenants/{tid}/keys", json={"label": "desk"}, headers=X)
        assert r.status_code == 201
        raw = r.json()["key"]
        r = req(c, "POST", f"/admin/api/tenants/{tid}/connections",
                json={"account": "123", "token": "  TOK_SECRET  "}, headers=X)
        assert r.status_code == 201 and r.json()["external_id"] == "act_123"
        assert store.get_token(tid, "meta", "act_123") == "TOK_SECRET"        # strip hua
        d = req(c, "GET", f"/admin/api/tenants/{tid}").json()
        assert d["tenant"]["name"] == "Flow Agency"
        assert [k["label"] for k in d["keys"]] == ["desk"] and d["connections"][0]["external_id"] == "act_123"
        mr = mcp_list_accounts(c, raw)
        assert mr.status_code == 200 and "act_123" in mr.text
        print("OK  tenant -> key -> account (123 -> act_123, token stripped) -> /mcp me key chali")

        # --- blank inputs ---
        for body in ({"name": ""}, {"name": "   "}, {}):
            assert req(c, "POST", "/admin/api/tenants", json=body, headers=X).status_code == 400
        for body in ({"account": "", "token": "t"}, {"account": "1", "token": "  "}, {"account": "  ", "token": ""}):
            assert req(c, "POST", f"/admin/api/tenants/{tid}/connections", json=body, headers=X).status_code == 400
        assert req(c, "POST", "/admin/api/tenants", data="not json", headers=X).status_code == 400
        print("OK  blank/invalid inputs 400")

        for bad_acct in ("act_1/2", "act_../../x", "abc", "1" * 40, "12 34"):
            assert req(c, "POST", f"/admin/api/tenants/{tid}/connections",
                       json={"account": bad_acct, "token": "t"}, headers=X).status_code == 400, bad_acct
        print("OK  galat account id 400")

        # --- unknown tenant / wrong tenant ---
        assert req(c, "GET", "/admin/api/tenants/nope").status_code == 404
        other = req(c, "POST", "/admin/api/tenants", json={"name": "Other"}, headers=X).json()["id"]
        kid = d["keys"][0]["id"]
        assert req(c, "DELETE", f"/admin/api/tenants/{other}/keys/{kid}", headers=X).status_code == 404
        assert req(c, "DELETE", f"/admin/api/tenants/{other}/connections/act_123", headers=X).status_code == 404
        assert mcp_list_accounts(c, raw).status_code == 200                      # key abhi bhi zinda
        assert store.get_token(tid, "meta", "act_123") == "TOK_SECRET"           # account abhi bhi hai
        print("OK  wrong-tenant revoke/delete 404, kuch nahi badla")

        # --- revoke / remove ---
        assert req(c, "DELETE", f"/admin/api/tenants/{tid}/keys/{kid}", headers=X).status_code == 200
        assert mcp_list_accounts(c, raw).status_code == 401
        assert req(c, "DELETE", f"/admin/api/tenants/{tid}/connections/123", headers=X).status_code == 200  # normalize
        assert req(c, "GET", f"/admin/api/tenants/{tid}").json()["connections"] == []
        print("OK  revoke -> /mcp 401; account remove")

        # --- leaks ---
        enc = [x["token_enc"] for x in store.conns] or ["<none>"]
        blob = "\n".join(SEEN)
        assert "TOK_SECRET" not in blob and not any(e in blob for e in enc if e != "<none>")
        assert blob.count(raw) == 1, "raw key sirf create-key response me hona chahiye"
        print("OK  koi response token/token_enc leak nahi karta; raw key sirf ek baar")

        # --- /mcp aur /health par asar nahi ---
        assert c.get("/health").json() == {"status": "ok"}
        assert c.post("/mcp", headers=MCP_HDR, json={}).status_code == 401
        key2 = store.create_api_key(other, "k")
        h = {**MCP_HDR, "Authorization": f"Bearer {key2}"}
        for m, p in [("GET", "/admin/api/tenants")]:
            c2 = TestClient(hosted_app.app, base_url="http://localhost")   # bina lifespan, bina cookie
            assert c2.request(m, p, headers=h).status_code == 401     # tenant Bearer key admin nahi kholti
        print("OK  /health, /mcp 401 waise hi; tenant key admin API nahi kholti")

        # --- store crash: admin ko error ka type/detail dikhe, bina login ke nahi ---
        c3 = TestClient(hosted_app.app, base_url="http://localhost", raise_server_exceptions=False)
        orig = store.list_tenants
        store.list_tenants = lambda: (_ for _ in ()).throw(RuntimeError("supabase down: boom-detail"))
        try:
            admin_auth.limiter.reset("testclient")
            assert c3.post("/admin/api/login", json={"password": os.environ["ADMIN_PASSWORD"]}, headers=X).status_code == 200
            r = c3.get("/admin/api/tenants")
            assert r.status_code == 500 and r.json()["type"] == "RuntimeError", r.text
            assert "boom-detail" in r.json()["detail"]
            r = TestClient(hosted_app.app, base_url="http://localhost", raise_server_exceptions=False).get("/admin/api/tenants")
            assert r.status_code == 401        # bina login ke 401, detail nahi
        finally:
            store.list_tenants = orig
        print("OK  store crash -> 500 JSON {type, detail} sirf logged-in admin ko")

        # --- logout ---
        assert req(c, "POST", "/admin/api/logout", headers=X).status_code == 200
        assert req(c, "GET", "/admin/api/tenants").status_code == 401
        print("OK  logout")

        # --- expired / tampered cookie ---
        c.cookies.set("admin_session", "1.deadbeef")
        assert req(c, "GET", "/admin/api/tenants").status_code == 401
        print("OK  bad cookie 401")
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
