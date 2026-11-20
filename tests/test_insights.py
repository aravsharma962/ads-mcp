"""Meta insights parsing + tool. Chalane ka: python tests/test_insights.py"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()

import ads_api  # noqa: E402
from ads_api import get_meta_insights, parse_insights_row  # noqa: E402

RAW = {
    "campaign_id": "c1", "campaign_name": "Camp", "adset_id": "s1", "adset_name": "Set",
    "ad_id": "a1", "ad_name": "Ad", "spend": "100", "impressions": "10000", "inline_link_clicks": "100",
    "actions": [{"action_type": "landing_page_view", "value": "80"},
                {"action_type": "add_to_cart", "value": "20"},
                {"action_type": "purchase", "value": "5"}],
    "action_values": [{"action_type": "purchase", "value": "500"}],
}


def test_parse_row_extracts_actions():
    r = parse_insights_row(RAW, "campaign")
    assert r["link_clicks"] == 100 and r["impressions"] == 10000 and r["spend"] == 100.0
    assert r["ctr"] == 1.0 and r["cpc"] == 1.0 and r["cpm"] == 10.0 and r["roas"] == 5.0
    assert r["landing_page_views"] == 80 and r["add_to_cart"] == 20 and r["purchases"] == 5
    assert r["purchase_value"] == 500.0 and r["thumbnail_url"] is None


def test_zero_denominators_give_none():
    r = parse_insights_row({**RAW, "impressions": "0", "inline_link_clicks": "0"}, "campaign")
    assert r["ctr"] is None and r["cpc"] is None and r["cpm"] is None
    r = parse_insights_row({**RAW, "spend": "0"}, "campaign")
    assert r["roas"] is None
    r = parse_insights_row({}, "ad")      # sab field gayab
    assert r["ctr"] is None and r["cpc"] is None and r["cpm"] is None and r["roas"] is None


def test_missing_actions_are_zero():
    r = parse_insights_row({"spend": "10", "impressions": "100", "inline_link_clicks": "5"}, "campaign")
    assert r["add_to_cart"] == 0 and r["purchases"] == 0 and r["landing_page_views"] == 0
    assert r["purchase_value"] == 0.0 and r["roas"] == 0.0


def test_level_selects_ids_and_names():
    ad = parse_insights_row(RAW, "ad")
    assert (ad["id"], ad["name"], ad["ad_id"], ad["adset_id"], ad["campaign_id"]) == ("a1", "Ad", "a1", "s1", "c1")
    camp = parse_insights_row(RAW, "campaign")
    assert (camp["id"], camp["name"], camp["adset_id"], camp["ad_id"]) == ("c1", "Camp", None, None)
    st = parse_insights_row(RAW, "adset")
    assert (st["id"], st["name"], st["adset_id"], st["ad_id"]) == ("s1", "Set", "s1", None)


def _resp(data, status=200):
    m = MagicMock(status_code=status)
    m.json.return_value = data
    return m


def test_request_uses_level_and_time_range():
    calls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append((url, headers, params))
        return _resp({"data": [{**RAW, "account_currency": "INR"}]})

    with patch("ads_api.requests.get", side_effect=fake_get):
        out = get_meta_insights("2026-11-01", "2026-11-07", "adset", "TOK", "act_1", "v27.0")
    url, headers, params = calls[0]
    assert url == "https://graph.facebook.com/v27.0/act_1/insights"
    assert headers == {"Authorization": "Bearer TOK"}
    assert params["level"] == "adset"
    assert json.loads(params["time_range"]) == {"since": "2026-11-01", "until": "2026-11-07"}
    for f in ("inline_link_clicks", "actions", "action_values", "account_currency"):
        assert f in params["fields"]
    assert out["currency"] == "INR" and out["attribution"] == "account default"
    assert out["rows"][0]["id"] == "s1"
    assert "TOK" not in url and "TOK" not in json.dumps(params)
    # bad level / dates
    for bad in (("2026-11-01", "2026-11-07", "bogus"), ("nope", "2026-11-07", "ad"), ("2026-11-09", "2026-11-07", "ad")):
        try:
            get_meta_insights(*bad, "TOK", "act_1", "v27.0")
            assert False, bad
        except ads_api.MetaError:
            pass


def test_ad_level_maps_thumbnails_and_survives_failure():
    def fake_get(url, headers=None, params=None, timeout=None):
        if url.endswith("/insights"):
            return _resp({"data": [{**RAW, "account_currency": "INR"}]})
        return _resp({"data": [{"id": "a1", "creative": {"thumbnail_url": "https://x/t.jpg"}}]})
    with patch("ads_api.requests.get", side_effect=fake_get):
        out = get_meta_insights("2026-11-01", "2026-11-07", "ad", "TOK", "act_1", "v27.0")
    assert out["rows"][0]["thumbnail_url"] == "https://x/t.jpg"

    def failing(url, headers=None, params=None, timeout=None):
        if url.endswith("/insights"):
            return _resp({"data": [{**RAW, "account_currency": "INR"}]})
        return _resp({"error": {"message": "boom"}}, 500)
    with patch("ads_api.requests.get", side_effect=failing):
        out = get_meta_insights("2026-11-01", "2026-11-07", "ad", "TOK", "act_1", "v27.0")
    assert out["rows"][0]["thumbnail_url"] is None


def test_non_finite_numbers_become_default():
    for bad in ("nan", "inf", "-inf", float("nan"), float("inf")):
        assert ads_api._num(bad) == 0.0, bad
    r = parse_insights_row({**RAW, "spend": "nan", "impressions": "10", "inline_link_clicks": "inf"}, "campaign")
    assert r["spend"] == 0.0 and r["link_clicks"] == 0
    assert ads_api._ratio(float("inf"), 5) is None and ads_api._ratio(5, float("nan")) is None
    assert ads_api._ratio(float("nan"), 5) is None


def test_insights_follow_paging_next_with_cap():
    urls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        urls.append((url, params))
        if url.endswith("/insights"):
            return _resp({"data": [{**RAW, "ad_id": "a1", "account_currency": "INR"}],
                          "paging": {"next": "https://graph.facebook.com/v27.0/act_1/insights?after=P2"}})
        if "after=P2" in url:
            return _resp({"data": [{**RAW, "ad_id": "a2", "account_currency": "INR"}]})
        return _resp({"data": []})
    with patch("ads_api.requests.get", side_effect=fake_get):
        out = get_meta_insights("2026-11-01", "2026-11-07", "campaign", "TOK", "act_1", "v27.0")
    assert len(out["rows"]) == 2, out["rows"]
    assert urls[1][0].endswith("after=P2") and not urls[1][1]

    # endless paging is capped
    n = {"c": 0}

    def endless(url, headers=None, params=None, timeout=None):
        n["c"] += 1
        return _resp({"data": [{**RAW, "account_currency": "INR"}],
                      "paging": {"next": f"https://graph.facebook.com/v27.0/act_1/insights?after=P{n['c']}"}})
    with patch("ads_api.requests.get", side_effect=endless):
        out = get_meta_insights("2026-11-01", "2026-11-07", "campaign", "TOK", "act_1", "v27.0")
    assert n["c"] == ads_api.MAX_PAGES and len(out["rows"]) == ads_api.MAX_PAGES


def test_thumbnails_follow_paging_next():
    def fake_get(url, headers=None, params=None, timeout=None):
        if url.endswith("/insights"):
            return _resp({"data": [{**RAW, "ad_id": "a1", "account_currency": "INR"},
                                   {**RAW, "ad_id": "a2", "account_currency": "INR"}]})
        if "after=T2" in url:
            return _resp({"data": [{"id": "a2", "creative": {"thumbnail_url": "https://x/2.jpg"}}]})
        return _resp({"data": [{"id": "a1", "creative": {"thumbnail_url": "https://x/1.jpg"}}],
                      "paging": {"next": "https://graph.facebook.com/v27.0/act_1/ads?after=T2"}})
    with patch("ads_api.requests.get", side_effect=fake_get):
        out = get_meta_insights("2026-11-01", "2026-11-07", "ad", "TOK", "act_1", "v27.0")
    assert [r["thumbnail_url"] for r in out["rows"]] == ["https://x/1.jpg", "https://x/2.jpg"]


def test_meta_errors_are_english():
    import requests
    for bad in ("2026/11/01", None):
        try:
            get_meta_insights(bad, "2026-11-02", "campaign", token="T", account="act_1")
            assert False, "expected MetaError"
        except ads_api.MetaError as e:
            assert "YYYY-MM-DD" in str(e) and "format" in str(e), str(e)
    try:
        get_meta_insights("2026-11-01", "2026-11-02", "bogus", token="T", account="act_1")
        assert False
    except ads_api.MetaError as e:
        assert "Invalid level" in str(e) and "adset" in str(e), str(e)
    with patch("ads_api.requests.get", side_effect=requests.ConnectionError("x")):
        try:
            get_meta_insights("2026-11-01", "2026-11-02", "campaign", token="T", account="act_1")
            assert False
        except ads_api.MetaError as e:
            assert "Could not connect to the Meta API" in str(e), str(e)


def test_hosted_tool_denies_foreign_account():
    from starlette.testclient import TestClient
    import hosted_app
    from store import get_store
    store = get_store()
    a = store.create_tenant("A"); b = store.create_tenant("B")
    ka = store.create_api_key(a.id)
    store.add_connection(a.id, "meta", "act_111", "TOKEN_A")
    store.add_connection(b.id, "meta", "act_222", "TOKEN_B")
    hdr = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
           "Authorization": f"Bearer {ka}"}
    seen = []

    def fake_get(url, headers=None, params=None, timeout=None):
        seen.append((url, headers["Authorization"]))
        return _resp({"data": [{**RAW, "account_currency": "INR"}]})

    def call(c, tool, args, i):
        r = c.post("/mcp", headers=hdr, json={"jsonrpc": "2.0", "id": i, "method": "tools/call",
                                              "params": {"name": tool, "arguments": args}})
        res = r.json()["result"]
        if "structuredContent" in res:
            return res["structuredContent"].get("result", res["structuredContent"])
        return json.loads(res["content"][0]["text"])

    with patch("ads_api.requests.get", side_effect=fake_get), TestClient(hosted_app.app) as c:
        mine = call(c, "meta_ads_insights", {"external_id": "111", "date_from": "2026-11-01",
                                             "date_to": "2026-11-07", "level": "ad"}, 1)
        assert mine["currency"] == "INR" and mine["rows"][0]["ad_id"] == "a1", mine
        assert seen[0] == ("https://graph.facebook.com/v27.0/act_111/insights", "Bearer TOKEN_A")
        n = len(seen)
        foreign = call(c, "meta_ads_insights", {"external_id": "act_222", "date_from": "2026-11-01",
                                                "date_to": "2026-11-07"}, 2)
        old = call(c, "meta_campaign_insights", {"external_id": "act_222"}, 3)
        assert foreign == old == {"error": "You do not have access to this account."}, (foreign, old)
        assert len(seen) == n


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
