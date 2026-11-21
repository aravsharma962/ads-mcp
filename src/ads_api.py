"""Meta Ads ka data laane wala logic.

Yeh file MCP se alag rakhi hai. Baad mein dashboard aur server dono isi ko use karenge.
"""
import json
import math
import os
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

# .env repo ke root mein hai (src ke ek level upar).
# utf-8-sig: Notepad kabhi file ke shuru mein chhupa BOM daal deta hai, usse bhi padh leta hai.
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH, encoding="utf-8-sig")

VALID_PRESETS = {
    "today", "yesterday", "last_7d", "last_14d", "last_30d", "this_month", "last_month",
}


class MetaError(Exception):
    """Meta API ka error, bina token dikhaye."""


def _config() -> tuple[str, str, str]:
    token = os.environ.get("META_ACCESS_TOKEN")
    account = os.environ.get("META_AD_ACCOUNT_ID")
    version = os.environ.get("META_API_VERSION", "v27.0")
    missing = [n for n, v in (("META_ACCESS_TOKEN", token), ("META_AD_ACCOUNT_ID", account)) if not v]
    if missing:
        # Sirf naam aur path batate hain, token ki value kabhi nahi.
        raise MetaError(
            f"Missing: {missing}. .env path: {ENV_PATH} (file maujood: {ENV_PATH.exists()})"
        )
    return token, account, version


def _num(value, default=0.0) -> float:
    """Meta kai numbers string mein deta hai ('12.5'). Isse float banate hain."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def _roas(purchase_roas) -> float:
    """purchase_roas ek list hoti hai: [{'action_type': ..., 'value': '9.2'}]."""
    if not purchase_roas:
        return 0.0
    return _num(purchase_roas[0].get("value"))


def get_meta_campaigns(date_preset: str = "last_7d", token: str | None = None,
                       account: str | None = None, version: str | None = None) -> list[dict]:
    """token/account na do to .env se lega (local stdio). Hosted server tenant ka token yahin pass karta hai."""
    if date_preset not in VALID_PRESETS:
        raise MetaError(f"Invalid date_preset. Choose one of: {sorted(VALID_PRESETS)}")

    if token is None or account is None:
        token, account, version = _config()
    version = version or os.environ.get("META_API_VERSION", "v27.0")
    resp = requests.get(
        f"https://graph.facebook.com/{version}/{account}/insights",
        # Token header mein bhejte hain, URL mein nahi, taaki error ya log mein leak na ho.
        headers={"Authorization": f"Bearer {token}"},
        params={
            "level": "campaign",
            "fields": "campaign_name,spend,impressions,clicks,ctr,cpc,cpm,purchase_roas",
            "date_preset": date_preset,
            "limit": 100,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        try:
            msg = resp.json()["error"]["message"]
        except Exception:
            msg = resp.text[:200]
        raise MetaError(f"Meta API error {resp.status_code}: {msg}")

    rows = resp.json().get("data", [])
    return [
        {
            "campaign": r.get("campaign_name"),
            "spend": _num(r.get("spend")),
            "impressions": int(_num(r.get("impressions"))),
            "clicks": int(_num(r.get("clicks"))),
            "ctr_pct": round(_num(r.get("ctr")), 2),  # Meta ctr pehle se % mein deta hai
            "cpc": round(_num(r.get("cpc")), 2),
            "cpm": round(_num(r.get("cpm")), 2),
            "roas": round(_roas(r.get("purchase_roas")), 2),
        }
        for r in rows
    ]


VALID_LEVELS = {"campaign", "adset", "ad"}
INSIGHTS_FIELDS = (
    "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,account_currency,"
    "spend,impressions,inline_link_clicks,frequency,reach,actions,action_values"
)


def _action(items, action_type: str) -> float:
    """Meta actions/action_values list se ek action_type ki value. Na mile to 0."""
    for it in items or []:
        if it.get("action_type") == action_type:
            return _num(it.get("value"))
    return 0.0


def _leads(actions) -> int:
    """Meta lead count. `lead` is the superset (website pixel + on-Facebook instant forms); instant forms are also
    reported as `onsite_conversion.lead_grouped`, so adding the two would double count. Use `lead` when Meta
    reports it, else `onsite_conversion.lead_grouped`."""
    items = actions or []
    if any(it.get("action_type") == "lead" for it in items):
        return int(_action(items, "lead"))
    return int(_action(items, "onsite_conversion.lead_grouped"))


def _ratio(num: float, den: float, scale: float = 1.0):
    """Denominator 0 ho to None (kabhi NaN/Infinity nahi)."""
    if not den or not math.isfinite(num) or not math.isfinite(den):
        return None
    out = num / den * scale
    return round(out, 4) if math.isfinite(out) else None


def parse_insights_row(raw: dict, level: str) -> dict:
    """Meta ki ek insights row ko hamare Row shape mein badalta hai. Rates denominator 0 par None."""
    spend = _num(raw.get("spend"))
    impressions = int(_num(raw.get("impressions")))
    reach = int(_num(raw.get("reach")))
    clicks = int(_num(raw.get("inline_link_clicks")))
    value = _action(raw.get("action_values"), "purchase")
    key = {"campaign": "campaign", "adset": "adset", "ad": "ad"}[level]
    return {
        "id": raw.get(f"{key}_id"),
        "name": raw.get(f"{key}_name"),
        "campaign_id": raw.get("campaign_id"),
        "adset_id": raw.get("adset_id") if level in ("adset", "ad") else None,
        "ad_id": raw.get("ad_id") if level == "ad" else None,
        "thumbnail_url": None,
        "spend": spend,
        "impressions": impressions,
        "link_clicks": clicks,
        "reach": reach,
        "frequency": _ratio(impressions, reach),
        "landing_page_views": int(_action(raw.get("actions"), "landing_page_view")),
        "add_to_cart": int(_action(raw.get("actions"), "add_to_cart")),
        "purchases": int(_action(raw.get("actions"), "purchase")),
        "purchase_value": value,
        "leads": _leads(raw.get("actions")),
        "ctr": _ratio(clicks, impressions, 100),
        "cpc": _ratio(spend, clicks),
        "cpm": _ratio(spend, impressions, 1000),
        "roas": _ratio(value, spend),
    }


def _check_date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError):
        raise MetaError("Date must be in YYYY-MM-DD format.")


def _meta_get(url: str, token: str, params: dict) -> dict:
    try:
        resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, params=params, timeout=30)
    except requests.RequestException as e:
        raise MetaError(f"Could not connect to the Meta API ({type(e).__name__}).")
    if resp.status_code != 200:
        try:
            msg = resp.json()["error"]["message"]
        except Exception:
            msg = resp.text[:200]
        raise MetaError(f"Meta API error {resp.status_code}: {msg}")
    return resp.json()


UNKNOWN_MSG = "unknown: Meta did not confirm the change. Check Ads Manager before trying again."
PERMISSION_MSG = "permission: the connected token cannot change ads (ads_management is missing)."


def _meta_post(url: str, token: str, data: dict) -> dict:
    """Meta write call. Token header mein jata hai. Permission error (code 200/10/#200) plain message banta hai."""
    try:
        resp = requests.post(url, headers={"Authorization": f"Bearer {token}"}, data=data, timeout=30)
    except requests.RequestException:
        raise MetaError(UNKNOWN_MSG)          # request may have reached Meta: outcome unclear
    if resp.status_code >= 500:
        raise MetaError(UNKNOWN_MSG)
    if resp.status_code != 200:
        err = {}
        try:
            err = resp.json()["error"]
            msg = err["message"]
        except Exception:
            msg = resp.text[:200]
        code = err.get("code") if isinstance(err, dict) else None
        if code in (200, 10) or str(msg).startswith("(#200)"):
            raise MetaError(PERMISSION_MSG)
        raise MetaError(f"Meta API error {resp.status_code}: {msg}")
    try:
        out = resp.json()
    except ValueError:
        raise MetaError(UNKNOWN_MSG)
    if not (isinstance(out, dict) and out.get("success") is True):
        raise MetaError(UNKNOWN_MSG)
    return out


WRITE_STATUSES = {"ACTIVE", "PAUSED"}
MAX_RAISE_PERCENT = 20
MIN_RAISABLE_BUDGET = 20     # minor units; below this the old+1 floor would exceed the 20% cap by a lot


def _object_url(object_id: str, version: str | None) -> str:
    # Sirf digits: id se URL path ke bahar nikalna (../, ?x=) mumkin nahi.
    if not isinstance(object_id, str) or not object_id.isascii() or not object_id.isdigit():
        raise MetaError("Invalid object id (digits only).")
    version = version or os.environ.get("META_API_VERSION", "v27.0")
    return f"https://graph.facebook.com/{version}/{object_id}"


def _check_same_account(obj: dict, account: str) -> None:
    """Object ka account_id connected account se na mile (ya na ho) to refuse. Meta account_id bina 'act_' deta hai."""
    got = str(obj.get("account_id") or "").strip()
    got = got if got.startswith("act_") else f"act_{got}"
    want = account.strip()
    want = want if want.startswith("act_") else f"act_{want}"
    if got == "act_" or got != want:
        raise MetaError("forbidden: this object does not belong to the connected ad account.")


def set_object_status(object_id: str, status: str, token: str, account: str,
                      version: str | None = None) -> dict:
    """Ad / adset / campaign ko ACTIVE ya PAUSED karta hai. Pehle verify: object isi account ka hai."""
    if status not in WRITE_STATUSES:
        raise MetaError(f"Invalid status. Choose one of: {sorted(WRITE_STATUSES)}")
    url = _object_url(object_id, version)
    obj = _meta_get(url, token, {"fields": "account_id,status"})
    _check_same_account(obj, account)
    current = obj.get("status")
    needed = {"PAUSED": "ACTIVE", "ACTIVE": "PAUSED"}[status]     # pause only ACTIVE, resume only PAUSED
    if current != needed:
        raise MetaError(f"unchanged: this object is currently {current} in Meta, so nothing was changed.")
    _meta_post(url, token, {"status": status})
    return {"before": {"status": obj.get("status")}, "after": {"status": status}}


def raise_budget(object_id: str, percent: int, token: str, account: str,
                 version: str | None = None) -> dict:
    """Daily budget ko 1..20% badhata hai (kabhi ghatata nahi). Lifetime budget par refuse. Minor currency units."""
    if type(percent) is not int or not 1 <= percent <= MAX_RAISE_PERCENT:
        raise MetaError(f"Invalid percent: must be a whole number from 1 to {MAX_RAISE_PERCENT}.")
    url = _object_url(object_id, version)
    obj = _meta_get(url, token, {"fields": "account_id,daily_budget,lifetime_budget"})
    _check_same_account(obj, account)
    if int(_num(obj.get("lifetime_budget"))) > 0:
        raise MetaError("budget_not_here: this object uses a lifetime budget, which cannot be changed here.")
    old = int(_num(obj.get("daily_budget")))
    if old <= 0:
        raise MetaError("budget_not_here: this object has no daily budget (it may be set on the campaign or ad set).")
    if old < MIN_RAISABLE_BUDGET:
        raise MetaError("budget_not_here: budget is too small to raise safely")
    new = max((old * (100 + percent) + 50) // 100, old + 1)
    _meta_post(url, token, {"daily_budget": str(new)})
    return {"before": {"daily_budget": old}, "after": {"daily_budget": new}}


MAX_PAGES = 50


def _meta_get_all(url: str, token: str, params: dict) -> list:
    """Meta list endpoint ke saare pages (paging.next), MAX_PAGES tak. Token sirf graph.facebook.com ko jata hai."""
    rows: list = []
    for _ in range(MAX_PAGES):
        data = _meta_get(url, token, params)
        rows.extend(data.get("data", []))
        nxt = (data.get("paging") or {}).get("next")
        if not nxt or urlparse(nxt).hostname != "graph.facebook.com":
            break
        url, params = nxt, None
    return rows


def _thumbnails(base: str, token: str) -> dict:
    """ad id -> thumbnail_url. Fail ho to {} (thumbnails None rahenge)."""
    try:
        ads = _meta_get_all(f"{base}/ads", token, {
            "fields": "id,creative{thumbnail_url}", "limit": 500,
            "filtering": json.dumps([{"field": "impressions", "operator": "GREATER_THAN", "value": 0}]),
        })
    except MetaError:
        return {}
    out = {}
    for ad in ads:
        url = (ad.get("creative") or {}).get("thumbnail_url")
        if ad.get("id") and url:
            out[ad["id"]] = url
    return out


def get_meta_insights(date_from: str, date_to: str, level: str = "campaign", token: str | None = None,
                      account: str | None = None, version: str | None = None) -> dict:
    """{"currency","attribution","rows"}. token/account na do to .env se (local stdio)."""
    if level not in VALID_LEVELS:
        raise MetaError(f"Invalid level. Choose one of: {sorted(VALID_LEVELS)}")
    since, until = _check_date(date_from), _check_date(date_to)
    if since > until:
        raise MetaError("date_from must be on or before date_to.")
    if token is None or account is None:
        token, account, version = _config()
    version = version or os.environ.get("META_API_VERSION", "v27.0")
    base = f"https://graph.facebook.com/{version}/{account}"
    raw_rows = _meta_get_all(f"{base}/insights", token, {
        "level": level, "fields": INSIGHTS_FIELDS, "limit": 500,
        "time_range": json.dumps({"since": since, "until": until}),
    })
    rows = [parse_insights_row(r, level) for r in raw_rows]
    currency = next((r.get("account_currency") for r in raw_rows if r.get("account_currency")), None)
    if currency is None:        # koi row nahi: account se currency lo (best effort)
        try:
            currency = _meta_get(base, token, {"fields": "currency"}).get("currency")
        except MetaError:
            currency = None
    if level == "ad" and rows:
        thumbs = _thumbnails(base, token)
        for r in rows:
            r["thumbnail_url"] = thumbs.get(r["ad_id"])
    return {"currency": currency, "attribution": "account default", "rows": rows}
