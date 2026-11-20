"""ads_performance: Meta insights + first-party tracking events ek table mein.

merge_performance pure hai (koi network/DB nahi). Rates hamesha summed totals se, denominator 0 par None.
"""
import uuid

from ads_api import MetaError, VALID_LEVELS, _check_date, _ratio, get_meta_insights
from tenancy import norm_account

SUM_FIELDS = ("spend", "impressions", "link_clicks", "landing_page_views", "add_to_cart", "purchases",
              "purchase_value", "leads")
LEAD_EVENTS = {"lead", "form_submit"}      # tracked lead = unique sessions with either event
DENIED = {"error": "You do not have access to this client."}      # exist kare ya na kare, same jawab
LEVEL_KEY = {"campaign": "campaign_id", "adset": "adset_id", "ad": "ad_id"}


def sum_rows(row_lists: list[list[dict]]) -> list[dict]:
    """Alag accounts ki rows ko id se jodta hai: counts ka sum, rates sums se dobara."""
    merged: dict[str, dict] = {}
    for rows in row_lists:
        for r in rows:
            m = merged.get(r["id"])
            if m is None:
                merged[r["id"]] = dict(r)
                continue
            for f in SUM_FIELDS:
                m[f] = (m.get(f) or 0) + (r.get(f) or 0)
            m["thumbnail_url"] = m.get("thumbnail_url") or r.get("thumbnail_url")
    for m in merged.values():
        m["ctr"] = _ratio(m["link_clicks"], m["impressions"], 100)
        m["cpc"] = _ratio(m["spend"], m["link_clicks"])
        m["cpm"] = _ratio(m["spend"], m["impressions"], 1000)
        m["roas"] = _ratio(m["purchase_value"], m["spend"])
    return list(merged.values())


def _bucket() -> dict:
    return {"sessions": set(), "atc": set(), "conv": set(), "value": 0.0,
            "signup": set(), "trial": set(), "demo": set(), "lead": set(), "paid": 0}


def _counts(b: dict) -> dict:
    return {"signup_sessions": len(b["signup"]), "trial_sessions": len(b["trial"]),
            "demo_sessions": len(b["demo"]), "lead_sessions": len(b["lead"]), "paid_events": b["paid"]}


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def merge_performance(meta_rows: list[dict], events: dict, conversion_events: list[str],
                      roas_source: str = "tracking") -> dict:
    """events = {"level": "ad|adset|campaign", "events": [{session_id, name, campaign_id, adset_id, ad_id, value}]}.

    Business-type counts: signup_sessions / trial_sessions / demo_sessions = unique sessions with a signup /
    trial_start / demo_booked event; lead_sessions = unique sessions with a lead or form_submit event;
    paid_events = number of paid events.
    sessions = unique sessions with any event; add_to_cart_sessions / conversion_sessions = unique sessions
    with an add_to_cart / conversion event. Events jinki id us level par nahi hai ya kisi Meta row se nahi
    milti, 'unattributed' mein jaate hain. tracked_value = 'purchase' events ki value ka sum.
    """
    key_field = LEVEL_KEY.get(events.get("level", "ad"), "ad_id")
    known = {r["id"] for r in meta_rows}
    buckets: dict[str, dict] = {}
    unattributed = _bucket()
    conv = set(conversion_events or [])
    for e in events.get("events", []):
        key = e.get(key_field)
        b = buckets.setdefault(key, _bucket()) if key in known else unattributed
        sid = e.get("session_id")
        if not sid:
            continue
        b["sessions"].add(sid)
        name = e.get("name")
        if name == "add_to_cart":
            b["atc"].add(sid)
        if name in conv:
            b["conv"].add(sid)
        if name == "purchase":
            b["value"] += _num(e.get("value"))
        if name == "signup":
            b["signup"].add(sid)
        elif name == "trial_start":
            b["trial"].add(sid)
        elif name == "demo_booked":
            b["demo"].add(sid)
        elif name == "paid":
            b["paid"] += 1                  # paid counts events (each payment), not unique sessions
        if name in LEAD_EVENTS:
            b["lead"].add(sid)
    rows = []
    for r in meta_rows:
        b = buckets.get(r["id"]) or _bucket()
        clicks = r.get("link_clicks") or 0
        tracked_roas = _ratio(b["value"], r.get("spend") or 0)
        rows.append({
            **r,
            "sessions": len(b["sessions"]),
            "add_to_cart_sessions": len(b["atc"]),
            "conversion_sessions": len(b["conv"]),
            "tracked_value": b["value"],
            **_counts(b),
            "visit_rate": _ratio(len(b["sessions"]), clicks, 100),
            "add_to_cart_rate": _ratio(len(b["atc"]), clicks, 100),
            "conversion_rate": _ratio(len(b["conv"]), clicks, 100),
            "tracked_roas": tracked_roas,
            "roas_effective": r.get("roas") if roas_source == "meta" else tracked_roas,
        })
    return {"rows": rows,
            "unattributed": {"sessions": len(unattributed["sessions"]),
                             "add_to_cart_sessions": len(unattributed["atc"]),
                             "conversion_sessions": len(unattributed["conv"]),
                             **_counts(unattributed)}}


def performance_for_client(store, tenant_id: str, client_id: str, date_from: str, date_to: str,
                           level: str, token_for) -> dict:
    """Tool ka asli kaam. Client tenant_id ka na ho to DENIED (koi data, koi Meta call nahi).

    token_for(account) -> token | None. Errors {"error": ...} ke roop mein (MetaError ya mismatch).
    """
    try:
        client_id = str(uuid.UUID(str(client_id)))
    except ValueError:
        return dict(DENIED)
    client = store.get_client(tenant_id, client_id)
    if client is None:
        return dict(DENIED)
    if level not in VALID_LEVELS:
        return {"error": f"Invalid level. Choose one of: {sorted(VALID_LEVELS)}"}
    try:
        since, until = _check_date(date_from), _check_date(date_to)
    except MetaError as e:
        return {"error": str(e)}
    if since > until:
        return {"error": "date_from must be on or before date_to."}
    accounts = store.list_client_accounts(client_id)
    if not accounts:
        return {"error": "This client has no ad accounts connected."}
    results = []
    for acct in accounts:
        account = norm_account(acct)
        token = token_for(account)
        if token is None:
            return {"error": f"Ad account {account} is no longer connected to your agency; reconnect it on the Accounts page."}
        try:
            results.append(get_meta_insights(since, until, level, token=token, account=account))
        except MetaError as e:
            return {"error": str(e)}
    currencies = {r["currency"] for r in results if r.get("currency")}
    if len(currencies) > 1:
        return {"error": f"This client's ad accounts use different currencies ({', '.join(sorted(currencies))}). "
                         "All accounts of one client must use the same currency."}
    rows = sum_rows([r["rows"] for r in results])
    events = store.events_summary(client_id, since, until, level)
    merged = merge_performance(rows, events, events.get("conversion_events") or ["purchase", "form_submit"],
                               client.get("roas_source") or "tracking")
    return {"currency": next(iter(currencies), client.get("currency")), "attribution": "account default",
            "roas_source": client.get("roas_source") or "tracking", **merged}
