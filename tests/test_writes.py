"""Meta write tools (pause/resume, raise budget). Chalane ka: python tests/test_writes.py"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()
SECRET = "hub-secret-for-tests-0123456789abcdef"
os.environ["HUB_SERVICE_SECRET"] = SECRET
os.environ.pop("ENABLE_META_WRITES", None)

import requests  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402
import ads_api  # noqa: E402
import hosted_app  # noqa: E402
from ads_api import MetaError, raise_budget, set_object_status  # noqa: E402
from store import get_store  # noqa: E402

store = get_store()
A = store.create_tenant("A"); B = store.create_tenant("B")
KEY_A = store.create_api_key(A.id)
store.add_connection(A.id, "meta", "act_111", "TOKEN_A_SECRET")
store.add_connection(B.id, "meta", "act_222", "TOKEN_B_SECRET")
URL = "https://graph.facebook.com/v27.0/777"


def _resp(data, status=200):
    m = MagicMock(status_code=status)
    m.json.return_value = data
    m.text = json.dumps(data)
    return m


class Meta:
    """Fake Graph API: one object, records every GET and POST."""

    def __init__(self, obj, post_resp=None, post_status=200):
        self.obj, self.gets, self.posts = obj, [], []
        self.post_resp = post_resp if post_resp is not None else {"success": True}
        self.post_status = post_status

    def get(self, url, headers=None, params=None, timeout=None):
        self.gets.append((url, headers, params))
        return _resp(self.obj)

    def post(self, url, headers=None, data=None, timeout=None):
        self.posts.append((url, headers, data))
        return _resp(self.post_resp, self.post_status)

    def __enter__(self):
        self.p = [patch("ads_api.requests.get", side_effect=self.get),
                  patch("ads_api.requests.post", side_effect=self.post)]
        for p in self.p:
            p.start()
        return self

    def __exit__(self, *a):
        for p in self.p:
            p.stop()


def raises(fn, *args, contains):
    try:
        fn(*args)
    except MetaError as e:
        assert contains in str(e), str(e)
        return str(e)
    assert False, f"expected MetaError containing {contains!r}"


# ---------- ads_api ----------

def test_set_status_ok():
    with Meta({"account_id": "111", "status": "ACTIVE"}) as m:
        out = set_object_status("777", "PAUSED", "TOK", "act_111", "v27.0")
    assert out == {"before": {"status": "ACTIVE"}, "after": {"status": "PAUSED"}}, out
    url, headers, params = m.gets[0]
    assert url == URL and headers == {"Authorization": "Bearer TOK"} and params == {"fields": "account_id,status"}
    url, headers, data = m.posts[0]
    assert url == URL and data == {"status": "PAUSED"} and headers == {"Authorization": "Bearer TOK"}
    assert "TOK" not in url and "TOK" not in json.dumps(data)


def test_set_status_wrong_account_refused_without_post():
    with Meta({"account_id": "222", "status": "ACTIVE"}) as m:
        raises(set_object_status, "777", "PAUSED", "TOK", "act_111", "v27.0", contains="forbidden")
    assert m.posts == []
    with Meta({"status": "ACTIVE"}) as m:                       # account_id missing -> refuse too
        raises(set_object_status, "777", "PAUSED", "TOK", "act_111", "v27.0", contains="forbidden")
    assert m.posts == []


def test_set_status_rejects_bad_input_before_any_request():
    with Meta({"account_id": "111", "status": "ACTIVE"}) as m:
        raises(set_object_status, "777", "DELETED", "TOK", "act_111", contains="Invalid status")
        raises(set_object_status, "777", "ARCHIVED", "TOK", "act_111", contains="Invalid status")
        for bad in ("777/../me", "abc", "", "7 7", "777?x=1"):
            raises(set_object_status, bad, "PAUSED", "TOK", "act_111", contains="Invalid object id")
    assert m.gets == [] and m.posts == []


def test_raise_budget_math():
    for old, pct, new in ((1000, 20, 1200), (20, 20, 24), (100, 1, 101), (25, 1, 26), (999, 20, 1199)):
        with Meta({"account_id": "111", "daily_budget": str(old), "lifetime_budget": "0"}) as m:
            out = raise_budget("777", pct, "TOK", "act_111", "v27.0")
        assert out == {"before": {"daily_budget": old}, "after": {"daily_budget": new}}, (old, pct, out)
        assert isinstance(out["after"]["daily_budget"], int)
        assert m.posts[0][2] == {"daily_budget": str(new)}, m.posts
        assert m.gets[0][2] == {"fields": "account_id,daily_budget,lifetime_budget"}


def test_raise_budget_refuses_tiny_budget():
    """Judgment call: below 20 minor units (e.g. 0.20 of a currency) the max(round, old+1) floor would turn a
    1..20% raise into a 5%..100% raise (5 -> 6 is +20%, 1 -> 2 is doubled). So refuse under 20, no POST."""
    for old in (1, 5, 10, 19):
        with Meta({"account_id": "111", "daily_budget": str(old), "lifetime_budget": "0"}) as m:
            raises(raise_budget, "777", 20, "TOK", "act_111", "v27.0",
                   contains="budget_not_here: budget is too small to raise safely")
        assert m.posts == [], old


def test_raise_budget_percent_must_be_1_to_20():
    with Meta({"account_id": "111", "daily_budget": "1000"}) as m:
        for bad in (0, 21, -5, 100, True, 1.5, "20", None):
            raises(raise_budget, "777", bad, "TOK", "act_111", contains="percent")
    assert m.gets == [] and m.posts == []


def test_raise_budget_refuses_lifetime_and_missing_budget():
    cases = [{"account_id": "111", "lifetime_budget": "50000"},
             {"account_id": "111", "daily_budget": "1000", "lifetime_budget": "50000"},
             {"account_id": "111", "daily_budget": "0", "lifetime_budget": "0"},
             {"account_id": "111"}]
    for obj in cases:
        with Meta(obj) as m:
            raises(raise_budget, "777", 20, "TOK", "act_111", "v27.0", contains="budget_not_here")
        assert m.posts == [], obj


def test_raise_budget_wrong_account_refused():
    with Meta({"account_id": "222", "daily_budget": "1000"}) as m:
        raises(raise_budget, "777", 20, "TOK", "act_111", "v27.0", contains="forbidden")
    assert m.posts == []


def test_permission_error_is_mapped():
    expected = "permission: the connected token cannot change ads (ads_management is missing)."
    for err in ({"code": 200, "message": "(#200) Requires ads_management permission"},
                {"code": 10, "message": "Application does not have permission for this action"},
                {"code": 1, "message": "(#200) Permissions error"}):
        with Meta({"account_id": "111", "status": "ACTIVE"}, post_resp={"error": err}, post_status=403):
            assert raises(set_object_status, "777", "PAUSED", "TOK", "act_111", "v27.0", contains="permission") == expected
    with Meta({"account_id": "111", "status": "ACTIVE"}, post_resp={"error": {"code": 100, "message": "bad"}},
              post_status=400):
        raises(set_object_status, "777", "PAUSED", "TOK", "act_111", "v27.0", contains="Meta API error 400: bad")


def test_set_status_only_when_current_status_allows():
    for cur, want in (("ACTIVE", "ACTIVE"), ("PAUSED", "PAUSED"), ("ARCHIVED", "PAUSED"), ("DELETED", "ACTIVE"),
                      ("PENDING_REVIEW", "PAUSED"), (None, "PAUSED")):
        with Meta({"account_id": "111", "status": cur}) as m:
            msg = raises(set_object_status, "777", want, "TOK", "act_111", "v27.0", contains="unchanged")
        assert msg == f"unchanged: this object is currently {cur} in Meta, so nothing was changed.", msg
        assert m.posts == [], (cur, want)
    with Meta({"account_id": "111", "status": "PAUSED"}) as m:
        out = set_object_status("777", "ACTIVE", "TOK", "act_111", "v27.0")
    assert out == {"before": {"status": "PAUSED"}, "after": {"status": "ACTIVE"}} and m.posts[0][2] == {"status": "ACTIVE"}


UNKNOWN = "unknown: Meta did not confirm the change. Check Ads Manager before trying again."


def test_post_ambiguous_outcomes_are_unknown():
    st = {"account_id": "111", "status": "ACTIVE"}
    bud = {"account_id": "111", "daily_budget": "1000", "lifetime_budget": "0"}
    for fn, args, obj in ((set_object_status, ("777", "PAUSED"), st), (raise_budget, ("777", 20), bud)):
        full = (*args, "TOK", "act_111", "v27.0")
        for exc in (requests.ConnectionError("x"), requests.Timeout("t")):
            with Meta(obj):
                with patch("ads_api.requests.post", side_effect=exc):
                    assert raises(fn, *full, contains="unknown: ") == UNKNOWN
        for status, body in ((500, {"error": {"message": "boom"}}), (503, {}), (502, {"success": True}),
                             (200, {"success": False}), (200, {}), (200, {"success": "true"}), (200, [])):
            with Meta(obj, post_resp=body, post_status=status):
                assert raises(fn, *full, contains="unknown: ") == UNKNOWN, (status, body)
        with Meta(obj, post_resp={"error": {"code": 100, "message": "bad"}}, post_status=400):   # clear rejection
            assert raises(fn, *full, contains="Meta API error 400: bad").startswith("Meta API")


def test_pre_change_get_errors_stay_plain():
    with patch("ads_api.requests.get", side_effect=requests.ConnectionError("x")), \
         patch("ads_api.requests.post") as post:
        raises(set_object_status, "777", "PAUSED", "TOK", "act_111", contains="Could not connect to the Meta API")
        raises(raise_budget, "777", 20, "TOK", "act_111", contains="Could not connect to the Meta API")
    assert not post.called
    with patch("ads_api.requests.get", return_value=_resp({"error": {"message": "x"}}, 500)):
        msg = raises(set_object_status, "777", "PAUSED", "TOK", "act_111", contains="Meta API error 500")
        assert not msg.startswith("unknown")


# ---------- hosted tools ----------

HDR = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
IH = {"X-Hub-Secret": SECRET, "X-Tenant-Id": A.id}


def mcp_call(c, tool, args):
    r = c.post("/mcp", headers={**HDR, "Authorization": f"Bearer {KEY_A}"},
               json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
    res = r.json()["result"]
    if "structuredContent" in res:
        return res["structuredContent"].get("result", res["structuredContent"])
    return json.loads(res["content"][0]["text"])


def internal_call(c, tool, args, tenant=None):
    h = {"X-Hub-Secret": SECRET, "X-Tenant-Id": (tenant or A).id}
    r = c.post("/internal/tools/call", headers=h, json={"name": tool, "arguments": args})
    assert r.status_code == 200, r.text
    return r.json()["result"]


c = TestClient(hosted_app.app)          # /internal needs no lifespan


def last_audit():
    return store.audit[-1]


STATUS_ARGS = {"external_id": "act_111", "object_id": "777", "level": "ad", "status": "PAUSED"}
BUDGET_ARGS = {"external_id": "act_111", "object_id": "777", "level": "adset", "percent": 20}
OBJ = {"account_id": "111", "status": "ACTIVE", "daily_budget": "1000", "lifetime_budget": "0"}
NOT_AVAILABLE = {"error": "Write tools are not available on this connection."}


def writes(on: bool):
    if on:
        os.environ["ENABLE_META_WRITES"] = "1"
    else:
        os.environ.pop("ENABLE_META_WRITES", None)


def test_writes_off_by_default_even_on_internal_api():
    writes(False)
    with Meta(OBJ) as m:
        for tool, args in (("meta_set_status", STATUS_ARGS), ("meta_raise_budget", BUDGET_ARGS)):
            out = internal_call(c, tool, args)
            assert "not enabled" in out["error"], out
            assert last_audit()["tool"] == tool and last_audit()["result"] == "denied"
        os.environ["ENABLE_META_WRITES"] = "true"           # only the exact value "1" turns writes on
        assert "not enabled" in internal_call(c, "meta_set_status", STATUS_ARGS)["error"]
        os.environ["ENABLE_META_WRITES"] = "0"
        assert "not enabled" in internal_call(c, "meta_set_status", STATUS_ARGS)["error"]
    writes(False)
    assert m.gets == [] and m.posts == []


def test_public_mcp_endpoint_can_never_write():
    seen_names = []
    with TestClient(hosted_app.app) as mc:       # lifespan can run only once per process: single `with`
        for on in (False, True):                 # refused even with the env flag on
            writes(on)
            with Meta(OBJ) as m:
                lst = mc.post("/mcp", headers={**HDR, "Authorization": f"Bearer {KEY_A}"},
                              json={"jsonrpc": "2.0", "id": 9, "method": "tools/list"}).json()
                seen_names = [t["name"] for t in lst["result"]["tools"]]
                assert "meta_set_status" not in seen_names and "meta_raise_budget" not in seen_names, seen_names
                for tool, args in (("meta_set_status", STATUS_ARGS), ("meta_raise_budget", BUDGET_ARGS)):
                    r = mc.post("/mcp", headers={**HDR, "Authorization": f"Bearer {KEY_A}"},
                                json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                      "params": {"name": tool, "arguments": args}}).json()
                    res = r.get("result", {})
                    assert "error" in r or res.get("isError") is True, r         # unknown tool over /mcp
                    assert '"ok": true' not in json.dumps(r).lower()
            assert m.gets == [] and m.posts == []
    writes(False)


def test_write_tool_functions_refuse_without_internal_context():
    """Defense in depth: even if the function is reached some other way, writes_allowed defaults to False."""
    from tenancy import set_current, reset_current
    assert hosted_app.writes_allowed.get() is False
    for on in (False, True):
        writes(on)
        ctx = set_current(A)
        try:
            with Meta(OBJ) as m:
                assert hosted_app.meta_set_status(**STATUS_ARGS) == NOT_AVAILABLE
                assert last_audit()["result"] == "denied" and last_audit()["tool"] == "meta_set_status"
                assert hosted_app.meta_raise_budget(**BUDGET_ARGS) == NOT_AVAILABLE
                assert last_audit()["result"] == "denied" and last_audit()["tool"] == "meta_raise_budget"
        finally:
            reset_current(ctx)
        assert m.gets == [] and m.posts == []
    writes(False)
    # permission is reset after an internal call
    writes(True)
    with Meta(OBJ):
        assert internal_call(c, "meta_set_status", STATUS_ARGS)["ok"] is True
    writes(False)
    assert hosted_app.writes_allowed.get() is False


def test_internal_status_change_ok_and_audited():
    writes(True)
    with Meta(OBJ) as m:
        out = internal_call(c, "meta_set_status", STATUS_ARGS)
    writes(False)
    assert out == {"ok": True, "object_id": "777", "level": "ad",
                   "before": {"status": "ACTIVE"}, "after": {"status": "PAUSED"}}, out
    assert m.posts[0][2] == {"status": "PAUSED"}
    assert m.gets[0][1] == {"Authorization": "Bearer TOKEN_A_SECRET"}          # tenant A's own token
    a = last_audit()
    assert (a["tenant_id"], a["tool"], a["result"]) == (A.id, "meta_set_status", "ok"), a
    assert "TOKEN_A_SECRET" not in json.dumps(a)


def test_internal_raise_budget_ok():
    writes(True)
    with Meta(OBJ) as m:
        out = internal_call(c, "meta_raise_budget", BUDGET_ARGS)
    writes(False)
    assert out == {"ok": True, "object_id": "777", "level": "adset",
                   "before": {"daily_budget": 1000}, "after": {"daily_budget": 1200}}, out
    assert m.posts[0][2] == {"daily_budget": "1200"}
    a = last_audit()
    assert (a["tool"], a["result"]) == ("meta_raise_budget", "ok") and a["args_redacted"]["percent"] == 20, a


def test_internal_foreign_account_denied_before_any_meta_call():
    writes(True)
    with Meta(OBJ) as m:
        for tool, args in (("meta_set_status", {**STATUS_ARGS, "external_id": "act_222"}),
                           ("meta_raise_budget", {**BUDGET_ARGS, "external_id": "222"}),
                           ("meta_set_status", {**STATUS_ARGS, "external_id": "act_999"})):
            out = internal_call(c, tool, args)
            assert out == {"error": "You do not have access to this account."}, out
            assert last_audit()["result"] == "denied"
    writes(False)
    assert m.gets == [] and m.posts == []


def test_internal_object_in_other_account_refused():
    writes(True)
    other = {**OBJ, "account_id": "222"}                       # object belongs to someone else's account
    with Meta(other) as m:
        for tool, args in (("meta_set_status", STATUS_ARGS), ("meta_raise_budget", BUDGET_ARGS)):
            out = internal_call(c, tool, args)
            assert "forbidden" in out["error"], out
            assert last_audit()["result"] == "denied"
    writes(False)
    assert m.posts == []


def test_internal_validation_errors():
    writes(True)
    with Meta(OBJ) as m:
        for pct in (21, 0, -1, 100):
            out = internal_call(c, "meta_raise_budget", {**BUDGET_ARGS, "percent": pct})
            assert "percent" in out["error"], out
            assert last_audit()["result"] == "denied"
        assert "Invalid level" in internal_call(c, "meta_set_status", {**STATUS_ARGS, "level": "account"})["error"]
        assert "Invalid status" in internal_call(c, "meta_set_status", {**STATUS_ARGS, "status": "DELETED"})["error"]
        assert "Invalid object id" in internal_call(c, "meta_set_status", {**STATUS_ARGS, "object_id": "7/8"})["error"]
    writes(False)
    assert m.gets == [] and m.posts == []


def test_internal_lifetime_budget_and_permission_error_are_plain_messages():
    writes(True)
    if True:
        with Meta({**OBJ, "daily_budget": None, "lifetime_budget": "50000"}) as m:
            out = internal_call(c, "meta_raise_budget", BUDGET_ARGS)
            assert out["error"].startswith("budget_not_here"), out
            assert last_audit()["result"] == "error" and m.posts == []
        with Meta(OBJ, post_resp={"error": {"code": 200, "message": "(#200) nope"}}, post_status=403):
            out = internal_call(c, "meta_set_status", STATUS_ARGS)
            assert out == {"error": "permission: the connected token cannot change ads (ads_management is missing)."}, out
            assert last_audit()["result"] == "error"
    writes(False)


def test_internal_unchanged_is_denied_and_unknown_is_error():
    writes(True)
    with Meta({**OBJ, "status": "PAUSED"}) as m:
        out = internal_call(c, "meta_set_status", STATUS_ARGS)
        assert out == {"error": "unchanged: this object is currently PAUSED in Meta, so nothing was changed."}, out
        assert last_audit()["result"] == "denied" and m.posts == []
    for tool, args in (("meta_set_status", STATUS_ARGS), ("meta_raise_budget", BUDGET_ARGS)):
        for status, body in ((500, {}), (200, {"success": False})):
            with Meta(OBJ, post_resp=body, post_status=status):
                assert internal_call(c, tool, args) == {"error": UNKNOWN}
                assert last_audit()["result"] == "error" and last_audit()["tool"] == tool
        with Meta(OBJ):
            with patch("ads_api.requests.post", side_effect=requests.Timeout("t")):
                assert internal_call(c, tool, args) == {"error": UNKNOWN}
                assert last_audit()["result"] == "error"
    with Meta({**OBJ, "daily_budget": "10"}) as m:
        out = internal_call(c, "meta_raise_budget", BUDGET_ARGS)
        assert out["error"].startswith("budget_not_here: budget is too small") and m.posts == []
        assert last_audit()["result"] == "error"
    writes(False)


def test_write_tools_are_listed_but_schema_has_no_tenant():
    if True:
        tools = {t["name"]: t for t in c.get("/internal/tools", headers=IH).json()}
    for name, fields in (("meta_set_status", {"external_id", "object_id", "level", "status"}),
                         ("meta_raise_budget", {"external_id", "object_id", "level", "percent"})):
        assert fields == set(tools[name]["input_schema"]["properties"]), tools[name]["input_schema"]


def test_tokens_never_in_audit_or_results():
    blob = json.dumps(store.audit)
    assert "TOKEN_A_SECRET" not in blob and "TOKEN_B_SECRET" not in blob and SECRET not in blob


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
