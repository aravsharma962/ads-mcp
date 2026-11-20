"""End-to-end test: HTTP MCP app, in-memory store, Meta API mocked. Chalane ka: python tests/test_hosted.py"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()

from starlette.testclient import TestClient  # noqa: E402
import hosted_app  # noqa: E402
from store import get_store  # noqa: E402

store = get_store()
a = store.create_tenant("Agency A"); b = store.create_tenant("Agency B")
key_a = store.create_api_key(a.id, "a-desktop"); key_b = store.create_api_key(b.id, "b-desktop")
store.add_connection(a.id, "meta", "act_111", "TOKEN_OF_A_SECRET")
store.add_connection(b.id, "meta", "act_222", "TOKEN_OF_B_SECRET")

HDR = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
_id = [0]


def rpc(client, method, params=None, key=None):
    _id[0] += 1
    h = dict(HDR)
    if key:
        h["Authorization"] = f"Bearer {key}"
    r = client.post("/mcp", headers=h, json={"jsonrpc": "2.0", "id": _id[0], "method": method, "params": params or {}})
    return r


def call(client, tool, args, key):
    r = rpc(client, "tools/call", {"name": tool, "arguments": args}, key)
    assert r.status_code == 200, (r.status_code, r.text)
    res = r.json()["result"]
    return res["structuredContent"]["result"]


ok = MagicMock(status_code=200)
ok.json.return_value = {"data": [{"campaign_name": "C1", "spend": "50", "impressions": "1000", "clicks": "10",
                                  "ctr": "1.0", "cpc": "5", "cpm": "50", "purchase_roas": [{"value": "3"}]}]}
seen_tokens = []


def fake_get(url, headers=None, params=None, timeout=None):
    seen_tokens.append((url, headers["Authorization"]))
    return ok


with patch("ads_api.requests.get", side_effect=fake_get):
    with TestClient(hosted_app.app) as c:
        assert c.get("/health").json() == {"status": "ok"}
        # 1. Key ke bina / galat key
        assert rpc(c, "tools/list").status_code == 401
        assert rpc(c, "tools/list", key="adsmcp_wrong").status_code == 401
        print("OK  no key / wrong key -> 401")
        # 2. Tools list
        names = [t["name"] for t in rpc(c, "tools/list", key=key_a).json()["result"]["tools"]]
        assert set(names) == {"list_my_accounts", "meta_campaign_insights", "meta_check_targets", "meta_ads_insights",
                     "ads_performance"}, names
        assert not any("tenant" in json.dumps(t["inputSchema"]) for t in rpc(c, "tools/list", key=key_a).json()["result"]["tools"])
        print("OK  tools:", names, "(koi tenant_id argument nahi)")
        # 3. Har tenant apni list dekhta hai
        assert call(c, "list_my_accounts", {}, key_a) == [{"platform": "meta", "external_id": "act_111"}]
        assert call(c, "list_my_accounts", {}, key_b) == [{"platform": "meta", "external_id": "act_222"}]
        print("OK  list_my_accounts alag alag")
        # 4. Apna account chalta hai, aur Meta ko apna token jaata hai
        out = call(c, "meta_campaign_insights", {"external_id": "111", "date_preset": "last_7d"}, key_a)
        assert out[0]["campaign"] == "C1", out
        assert seen_tokens[-1] == ("https://graph.facebook.com/v27.0/act_111/insights", "Bearer TOKEN_OF_A_SECRET"), seen_tokens
        out = call(c, "meta_check_targets", {"external_id": "act_222"}, key_b)
        assert out[0]["status"] == "MISS", out
        assert seen_tokens[-1][1] == "Bearer TOKEN_OF_B_SECRET"
        print("OK  own account works, sahi tenant ka token Meta ko gaya")
        # 5. ISOLATION: A, B ka account maange to deny
        n_calls = len(seen_tokens)
        out = call(c, "meta_campaign_insights", {"external_id": "act_222"}, key_a)
        assert out == {"error": "You do not have access to this account."}, out
        out2 = call(c, "meta_campaign_insights", {"external_id": "act_999_not_exists"}, key_a)
        assert out2 == out   # exist karta hai ya nahi, same jawab
        assert len(seen_tokens) == n_calls, "Meta ko call nahi jaani chahiye thi"
        print("OK  tenant A -> B ka account: denied, Meta call nahi hui")
        # Revoked key
        store.revoke_api_key(key_a)
        assert rpc(c, "tools/list", key=key_a).status_code == 401
        print("OK  revoked key -> 401")

# 6. Audit
tools = [(x["tenant_id"] == a.id, x["tool"], x["result"]) for x in store.audit]
assert (True, "meta_campaign_insights", "denied") in tools
assert (True, "meta_campaign_insights", "ok") in tools
print("OK  audit log:", len(store.audit), "entries")
# 7. Tokens encrypted store mein, plain nahi
assert all("SECRET" not in json.dumps(cn) for cn in store.conns)
assert all(cn["token_enc"].startswith("gAAAA") for cn in store.conns)
print("OK  tokens encrypted at rest")
# 9. Raw key store mein nahi
assert all(key_a not in json.dumps(k) for k in store.keys)
print("OK  API key sirf hash ke roop mein stored")
print("\nALL TESTS PASSED")
