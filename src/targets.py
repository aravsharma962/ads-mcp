"""Targets: aapke notes ke hisaab se. Badalna ho to sirf yahin badlo.

Har campaign ko in limits se milaya jaata hai. Yeh file Meta ya MCP ke bare mein kuch nahi jaanti,
sirf numbers ki tulna karti hai, isliye isko test karna aasan hai.
"""

TARGETS = {
    "ctr_min": 3.0,    # CTR % kam se kam
    "cpc_max": 20.0,   # CPC zyada se zyada (account currency)
    "cpm_max": 14.0,   # CPM zyada se zyada (notes: 13 se 14)
    "roas_min": 9.0,   # ROAS kam se kam (notes: 9 se 12x)
}


def check_campaign(row: dict, targets: dict = TARGETS) -> dict:
    """Ek campaign ko targets se milata hai. Status: OK, MISS ya NO_DATA."""
    # Impressions 0 hain to CTR/CPC/CPM ka koi matlab nahi, isko fail mat batao.
    if row.get("impressions", 0) == 0:
        return {"campaign": row.get("campaign"), "status": "NO_DATA", "misses": []}

    misses = []
    if row["ctr_pct"] < targets["ctr_min"]:
        misses.append(f"CTR {row['ctr_pct']}% (target {targets['ctr_min']}%+)")
    # CPC 0 ka matlab clicks nahi hue, isko "sasta" mat samjho.
    if row["clicks"] > 0 and row["cpc"] > targets["cpc_max"]:
        misses.append(f"CPC {row['cpc']} (max {targets['cpc_max']})")
    if row["cpm"] > targets["cpm_max"]:
        misses.append(f"CPM {row['cpm']} (max {targets['cpm_max']})")
    # ROAS sirf tab judge karo jab spend hua ho.
    if row["spend"] > 0 and row["roas"] < targets["roas_min"]:
        misses.append(f"ROAS {row['roas']}x (target {targets['roas_min']}x+)")

    return {
        "campaign": row.get("campaign"),
        "status": "MISS" if misses else "OK",
        "misses": misses,
    }
