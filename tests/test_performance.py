"""ads_performance tool + merge_performance. Chalane ka: python tests/test_performance.py"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()

from performance import merge_performance, sum_rows  # noqa: E402

CONV = ["purchase", "form_submit"]


def meta_row(ad="X", clicks=100, spend=100.0, roas=7.0, level="ad"):
    return {"id": ad, "name": f"Ad {ad}", "campaign_id": "c1", "adset_id": "s1", "ad_id": ad,
            "thumbnail_url": None, "spend": spend, "impressions": 10000, "link_clicks": clicks,
            "landing_page_views": 50, "add_to_cart": 0, "purchases": 0, "purchase_value": 0.0,
            "ctr": 1.0, "cpc": 1.0, "cpm": 10.0, "roas": roas}


def ev(session, name, ad="X", value=None, campaign="c1", adset="s1"):
    return {"session_id": session, "name": name, "ad_id": ad, "adset_id": adset, "campaign_id": campaign,
            "value": value}


def events(*evs, level="ad"):
    return {"level": level, "events": list(evs), "conversion_events": CONV}


def one(out, ad="X"):
    return next(r for r in out["rows"] if r["id"] == ad)


def test_merge_counts_unique_sessions_per_ad():
    e = events(ev("s1", "page_view"), ev("s2", "page_view"),
               ev("s1", "add_to_cart"), ev("s1", "add_to_cart"), ev("s2", "add_to_cart"))
    r = one(merge_performance([meta_row()], e, CONV))
    assert r["add_to_cart_sessions"] == 2 and r["sessions"] == 2 and r["conversion_sessions"] == 0


def test_rates_use_link_clicks_denominator():
    evs = []
    for i in range(80):
        evs.append(ev(f"s{i}", "page_view"))
    for i in range(14):
        evs.append(ev(f"s{i}", "add_to_cart"))
    for i in range(10):
        evs.append(ev(f"s{i}", "purchase", value=90.0))
    r = one(merge_performance([meta_row(clicks=100)], events(*evs), CONV))
    assert (r["sessions"], r["add_to_cart_sessions"], r["conversion_sessions"]) == (80, 14, 10)
    assert r["visit_rate"] == 80.0 and r["add_to_cart_rate"] == 14.0 and r["conversion_rate"] == 10.0


def test_conversion_sessions_are_unique_across_event_names():
    e = events(ev("s1", "purchase", value=5.0), ev("s1", "form_submit"), ev("s2", "other_event"))
    r = one(merge_performance([meta_row()], e, CONV))
    assert r["conversion_sessions"] == 1 and r["sessions"] == 2


def test_zero_clicks_gives_none():
    e = events(ev("s1", "page_view"), ev("s1", "purchase", value=10.0))
    r = one(merge_performance([meta_row(clicks=0, spend=0.0, roas=None)], e, CONV))
    assert r["visit_rate"] is None and r["add_to_cart_rate"] is None and r["conversion_rate"] is None
    assert r["tracked_roas"] is None
    for k in ("visit_rate", "add_to_cart_rate", "conversion_rate", "tracked_roas"):
        assert r[k] is None or (r[k] == r[k] and abs(r[k]) != float("inf"))


def test_unattributed_bucket():
    e = events(ev("s1", "page_view"), ev("s2", "page_view", ad=None, adset=None, campaign=None),
               ev("s2", "add_to_cart", ad=None, adset=None, campaign=None),
               ev("s3", "form_submit", ad=None, adset=None, campaign=None),
               ev("s3", "page_view", ad="UNKNOWN_AD"))
    out = merge_performance([meta_row()], e, CONV)
    assert out["unattributed"] == {"sessions": 2, "add_to_cart_sessions": 1, "conversion_sessions": 1,
                                   "signup_sessions": 0, "trial_sessions": 0, "demo_sessions": 0,
                                   "lead_sessions": 1, "paid_events": 0}, out["unattributed"]   # form_submit is a lead
    assert one(out)["sessions"] == 1           # sirf apne ad ke events
    # level adset: adset_id se match
    row = {**meta_row(ad="s1"), "id": "s1", "ad_id": None}
    out = merge_performance([row], events(ev("a", "page_view", ad=None), level="adset"), CONV)
    assert one(out, "s1")["sessions"] == 1


def test_tracked_roas():
    e = events(ev("s1", "purchase", value=400.0), ev("s2", "purchase", value=500.0), ev("s3", "form_submit", value=999.0))
    r = one(merge_performance([meta_row(spend=100.0)], e, CONV))
    assert r["tracked_value"] == 900.0 and r["tracked_roas"] == 9.0


def test_roas_source_meta_uses_meta_roas():
    e = events(ev("s1", "purchase", value=900.0))
    r = one(merge_performance([meta_row(spend=100.0, roas=7.0)], e, CONV, roas_source="meta"))
    assert r["roas_effective"] == 7.0 and r["tracked_roas"] == 9.0 and r["roas"] == 7.0
    r = one(merge_performance([meta_row(spend=100.0, roas=7.0)], e, CONV, roas_source="tracking"))
    assert r["roas_effective"] == 9.0


def test_business_type_event_counts():
    e = events(ev("s1", "signup"), ev("s1", "signup"), ev("s2", "signup"), ev("s2", "trial_start"),
               ev("s3", "demo_booked"), ev("s3", "demo_booked"), ev("s4", "lead"), ev("s5", "form_submit"),
               ev("s4", "form_submit"), ev("s6", "paid", value=50.0), ev("s6", "paid", value=50.0), ev("s7", "paid"))
    r = one(merge_performance([meta_row()], e, CONV))
    assert r["signup_sessions"] == 2 and r["trial_sessions"] == 1 and r["demo_sessions"] == 1
    assert r["lead_sessions"] == 2            # s4 (lead + form_submit) counted once, plus s5
    assert r["paid_events"] == 3              # paid counts events, not sessions
    assert r["sessions"] == 7


def test_event_counts_default_to_zero_and_are_attributed_per_ad():
    r = one(merge_performance([meta_row()], events(ev("s1", "page_view")), CONV))
    for k in ("signup_sessions", "trial_sessions", "demo_sessions", "lead_sessions", "paid_events"):
        assert r[k] == 0, k
    e = events(ev("s1", "signup", ad="OTHER"), ev("s2", "signup", ad="X"))
    out = merge_performance([meta_row("X"), meta_row("OTHER")], e, CONV)
    assert one(out, "X")["signup_sessions"] == 1 and one(out, "OTHER")["signup_sessions"] == 1


def test_unattributed_has_event_counts():
    e = events(ev("a", "signup", ad=None, adset=None, campaign=None), ev("a", "trial_start", ad=None, adset=None, campaign=None),
               ev("b", "demo_booked", ad="UNKNOWN"), ev("c", "lead", ad=None), ev("d", "paid", ad=None), ev("e", "paid", ad=None),
               ev("f", "signup", ad="X"))
    out = merge_performance([meta_row()], e, CONV)
    u = out["unattributed"]
    assert (u["signup_sessions"], u["trial_sessions"], u["demo_sessions"], u["lead_sessions"], u["paid_events"]) == (1, 1, 1, 1, 2), u
    assert u["sessions"] == 5 and one(out)["signup_sessions"] == 1


def test_sum_rows_adds_leads_across_accounts():
    a = [{**meta_row("X"), "leads": 4}]
    b = [{**meta_row("X"), "leads": 6}]
    merged = sum_rows([a, b])
    assert len(merged) == 1 and merged[0]["leads"] == 10


def test_leads_present_when_a_meta_row_lacks_the_field():
    merged = sum_rows([[meta_row("X")], [{**meta_row("X"), "leads": 2}]])
    assert merged[0]["leads"] == 2


# ---- tool level ----
from starlette.testclient import TestClient  # noqa: E402
import hosted_app  # noqa: E402
from store import get_store  # noqa: E402

store = get_store()
A = store.create_tenant("A"); B = store.create_tenant("B")
key_a = store.create_api_key(A.id)
store.add_connection(A.id, "meta", "act_1", "TOKEN_A1")
store.add_connection(A.id, "meta", "act_2", "TOKEN_A2")
store.add_connection(B.id, "meta", "act_9", "TOKEN_B9")
ca = store.create_client(A.id, "Brand A", "INR", "Asia/Kolkata", "tracking")
cb = store.create_client(B.id, "Brand B", "INR", "Asia/Kolkata", "tracking")
cmix = store.create_client(A.id, "Mixed", "INR", "Asia/Kolkata", "tracking")
store.add_client_account(ca["id"], "meta", "act_1")
store.add_client_account(ca["id"], "meta", "act_2")
store.add_client_account(cb["id"], "meta", "act_9")
store.add_client_account(cmix["id"], "meta", "act_1")
store.add_client_account(cmix["id"], "meta", "act_3")
store.add_connection(A.id, "meta", "act_3", "TOKEN_A3")
store.add_event(ca["id"], "s1", "page_view", ad_id="X", adset_id="s1", campaign_id="c1", ts="2026-11-03T10:00:00+00:00")
store.add_event(ca["id"], "s1", "purchase", ad_id="X", adset_id="s1", campaign_id="c1", value=250.0,
                ts="2026-11-03T10:05:00+00:00")
store.add_event(ca["id"], "s9", "page_view", ts="2026-11-04T10:00:00+00:00")                 # unattributed
store.add_event(ca["id"], "s_leave", "page_leave", ts="2026-11-04T10:05:00+00:00")           # must be excluded
store.add_event(ca["id"], "old", "page_view", ad_id="X", ts="2026-10-01T10:00:00+00:00")     # range ke bahar
store.add_event(cb["id"], "b1", "purchase", ad_id="X", value=777.0, ts="2026-11-03T10:00:00+00:00")  # doosra client

HDR = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
       "Authorization": f"Bearer {key_a}"}
CURRENCY = {"act_1": "INR", "act_2": "INR", "act_3": "USD"}
seen = []
TC = TestClient(hosted_app.app)
TC.__enter__()          # session manager process mein ek hi baar chal sakta hai


def resp(data, status=200):
    m = MagicMock(status_code=status)
    m.json.return_value = data
    return m


def fake_get(url, headers=None, params=None, timeout=None):
    seen.append(url)
    acct = url.split("/")[-2] if url.endswith("/insights") else None
    if acct is None:
        return resp({"data": []})
    raw = {"campaign_id": "c1", "campaign_name": "C", "adset_id": "s1", "adset_name": "S", "ad_id": "X",
           "ad_name": "Ad X", "account_currency": CURRENCY[acct], "spend": "50", "impressions": "5000",
           "inline_link_clicks": "40", "actions": [{"action_type": "add_to_cart", "value": "4"}],
           "action_values": [{"action_type": "purchase", "value": "100"}]}
    return resp({"data": [raw]})


def call(c, args, i=1):
    r = c.post("/mcp", headers=HDR, json={"jsonrpc": "2.0", "id": i, "method": "tools/call",
                                          "params": {"name": "ads_performance", "arguments": args}})
    res = r.json()["result"]
    if "structuredContent" in res:
        return res["structuredContent"].get("result", res["structuredContent"])
    return json.loads(res["content"][0]["text"])


def test_tool_sums_accounts_and_recomputes_rates():
    with patch("ads_api.requests.get", side_effect=fake_get):
        c = TC
        out = call(c, {"client_id": ca["id"], "date_from": "2026-11-01", "date_to": "2026-11-07", "level": "ad"})
    assert out["currency"] == "INR", out
    r = one(out)
    assert r["spend"] == 100.0 and r["link_clicks"] == 80 and r["impressions"] == 10000     # 2 accounts ka sum
    assert r["ctr"] == 0.8 and r["cpc"] == 1.25 and r["cpm"] == 10.0 and r["roas"] == 2.0   # sums se recompute
    assert r["sessions"] == 1 and r["conversion_sessions"] == 1 and r["tracked_value"] == 250.0
    assert r["visit_rate"] == 1.25 and r["tracked_roas"] == 2.5
    assert out["unattributed"] == {"sessions": 1, "add_to_cart_sessions": 0, "conversion_sessions": 0,
                                   "signup_sessions": 0, "trial_sessions": 0, "demo_sessions": 0,
                                   "lead_sessions": 0, "paid_events": 0}, out["unattributed"]
    assert r["leads"] == 0 and r["signup_sessions"] == 0 and r["paid_events"] == 0
    assert out["roas_source"] == "tracking"


def test_foreign_client_denied():
    with patch("ads_api.requests.get", side_effect=fake_get):
        c = TC
        n = len(seen)
        out = call(c, {"client_id": cb["id"], "date_from": "2026-11-01", "date_to": "2026-11-07"})
        out2 = call(c, {"client_id": "00000000-0000-0000-0000-000000000000", "date_from": "2026-11-01",
                        "date_to": "2026-11-07"}, 2)
        out3 = call(c, {"client_id": "not-a-uuid", "date_from": "2026-11-01", "date_to": "2026-11-07"}, 3)
    assert out == {"error": "You do not have access to this client."} and out2 == out and out3 == out, out
    assert len(seen) == n, "Meta ko call nahi jaani chahiye thi"
    assert any(x["tool"] == "ads_performance" and x["result"] == "denied" and x["tenant_id"] == A.id
               for x in store.audit)
    assert "777" not in json.dumps(out)


def test_mixed_currency_accounts_rejected():
    with patch("ads_api.requests.get", side_effect=fake_get):
        c = TC
        out = call(c, {"client_id": cmix["id"], "date_from": "2026-11-01", "date_to": "2026-11-07"})
    assert "error" in out and "currency" in out["error"].lower(), out
    assert "TOKEN" not in json.dumps(out)


def test_bad_input_returns_error():
    with patch("ads_api.requests.get", side_effect=fake_get):
        c = TC
        assert "error" in call(c, {"client_id": ca["id"], "date_from": "x", "date_to": "2026-11-07"})
        assert "error" in call(c, {"client_id": ca["id"], "date_from": "2026-11-01", "date_to": "2026-11-07",
                                   "level": "zzz"}, 2)


def test_error_messages_are_english():
    import re
    HINGLISH = re.compile(r"\b(nahi|hai|hain|chahiye|galat|chuno|jodo|jude|mein|aapka|par|se pehle)\b", re.I)
    with patch("ads_api.requests.get", side_effect=fake_get):
        c = TC
        base = {"client_id": ca["id"], "date_from": "2026-11-01", "date_to": "2026-11-07"}
        msgs = [
            call(c, {**base, "date_from": "x"})["error"],
            call(c, {**base, "level": "zzz"}, 2)["error"],
            call(c, {**base, "date_from": "2026-11-09"}, 3)["error"],
            call(c, {**base, "client_id": cmix["id"]}, 4)["error"],
            call(c, {**base, "client_id": "nope"}, 5)["error"],
        ]
    assert "YYYY-MM-DD" in msgs[0] and "level" in msgs[1] and "adset" in msgs[1], msgs
    assert "date_from" in msgs[2] and "on or before" in msgs[2], msgs
    for m in msgs:
        assert not HINGLISH.search(m), m


def test_store_isolation_and_range():
    assert store.get_client(A.id, cb["id"]) is None and store.get_client(B.id, cb["id"])["name"] == "Brand B"
    assert store.list_client_accounts(ca["id"]) == ["act_1", "act_2"]
    s = store.events_summary(ca["id"], "2026-11-01", "2026-11-07", "ad")
    assert {e["session_id"] for e in s["events"]} == {"s1", "s9"}            # 'old' aur doosre client ke nahi
    assert s["level"] == "ad"
    s2 = store.events_summary(ca["id"], "2026-11-03", "2026-11-03", "ad")      # inclusive single day (IST)
    assert {e["session_id"] for e in s2["events"]} == {"s1"}


def test_events_summary_excludes_page_leave():
    s = store.events_summary(ca["id"], "2026-11-01", "2026-11-07", "ad")
    assert all(e["name"] != "page_leave" for e in s["events"]), s["events"]
    assert "s_leave" not in {e["session_id"] for e in s["events"]}


def test_supabase_events_summary_filters_page_leave():
    from store import SupabaseStore
    calls = []

    class Q:
        def __init__(self, data): self.data = data
        def __getattr__(self, n):
            def f(*a, **k):
                calls.append((n, a))
                return self
            return f
        def execute(self):
            return MagicMock(data=self.data)

    class DB:
        def table(self, name):
            return Q([{"timezone": "Asia/Kolkata"}] if name == "clients" else [])

    st = SupabaseStore.__new__(SupabaseStore)
    st.db = DB()
    st.events_summary("c", "2026-11-01", "2026-11-07", "ad")
    assert ("neq", ("name", "page_leave")) in calls, calls


def test_merge_ignores_page_leave():
    e = events(ev("s1", "page_view"), ev("s2", "page_leave"), ev("s1", "page_leave"))
    r = one(merge_performance([meta_row()], e, CONV))
    assert r["sessions"] == 1, r
    lone = merge_performance([meta_row()], events(ev("s3", "page_leave")), CONV)
    assert one(lone)["sessions"] == 0 and lone["unattributed"]["sessions"] == 0, lone


def test_merge_sums_reach_and_recomputes_frequency():
    a = {**meta_row(), "reach": 4000, "frequency": 2.5}          # impressions 10000
    b = {**meta_row(), "reach": 1000, "frequency": 10.0}         # same ad id in a second account
    out = sum_rows([[a], [b]])
    assert len(out) == 1 and out[0]["reach"] == 5000 and out[0]["impressions"] == 20000
    assert out[0]["frequency"] == 4.0, out[0]                    # 20000 / 5000


def test_merge_frequency_none_when_reach_zero_or_missing():
    out = sum_rows([[{**meta_row(), "reach": 0, "frequency": None}], [meta_row()]])
    assert out[0]["reach"] == 0 and out[0]["frequency"] is None, out[0]
    single = sum_rows([[meta_row()]])
    assert single[0]["frequency"] is None


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
