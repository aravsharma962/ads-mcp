"""MCP server: Claude yahan se hamare tools call karta hai."""
from mcp.server.fastmcp import FastMCP

from ads_api import MetaError, get_meta_campaigns
from targets import check_campaign

mcp = FastMCP("ads-manager")


@mcp.tool()
def ping() -> str:
    """Check karta hai ki server zinda hai. Hamesha 'pong' lautata hai."""
    return "pong"


@mcp.tool()
def meta_campaign_insights(date_preset: str = "last_7d") -> list[dict] | dict:
    """Meta Ads campaigns ka performance: spend, impressions, clicks, CTR %, CPC, CPM, ROAS.

    date_preset: today, yesterday, last_7d, last_14d, last_30d, this_month, last_month.
    Sirf padhta hai, kuch badalta nahi.
    """
    try:
        rows = get_meta_campaigns(date_preset)
    except MetaError as e:
        # Error ko saaf text mein lautate hain, taaki Claude user ko samjha sake.
        return {"error": str(e)}
    return rows or {"message": "Is period mein koi campaign data nahi mila (spend 0 ho sakta hai)."}


@mcp.tool()
def meta_check_targets(date_preset: str = "last_7d") -> list[dict] | dict:
    """Meta campaigns ko targets (CTR, CPC, CPM, ROAS) se milata hai.

    Har campaign ke liye status deta hai: OK, MISS (kaunsa target miss hua), ya NO_DATA.
    date_preset: today, yesterday, last_7d, last_14d, last_30d, this_month, last_month.
    Sirf padhta hai, kuch badalta nahi.
    """
    try:
        rows = get_meta_campaigns(date_preset)
    except MetaError as e:
        return {"error": str(e)}
    if not rows:
        return {"message": "Is period mein koi campaign data nahi mila (spend 0 ho sakta hai)."}
    return [check_campaign(r) for r in rows]


if __name__ == "__main__":
    mcp.run()
