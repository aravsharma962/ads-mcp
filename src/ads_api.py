"""Meta Ads ka data laane wala logic.

Yeh file MCP se alag rakhi hai. Baad mein dashboard aur server dono isi ko use karenge.
"""
import os
from pathlib import Path

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
        return float(value)
    except (TypeError, ValueError):
        return default


def _roas(purchase_roas) -> float:
    """purchase_roas ek list hoti hai: [{'action_type': ..., 'value': '9.2'}]."""
    if not purchase_roas:
        return 0.0
    return _num(purchase_roas[0].get("value"))


def get_meta_campaigns(date_preset: str = "last_7d") -> list[dict]:
    if date_preset not in VALID_PRESETS:
        raise MetaError(f"date_preset galat hai. Chuno: {sorted(VALID_PRESETS)}")

    token, account, version = _config()
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
