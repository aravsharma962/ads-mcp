"""Admin CLI: dashboard banne tak tenants, API keys aur ad account connections yahin se banenge.

Chalane se pehle .env mein SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY aur TOKEN_ENC_KEY rakho.

  python scripts/admin.py gen-enc-key
  python scripts/admin.py create-tenant "Agency A"
  python scripts/admin.py create-key <tenant_id> "claude-desktop"
  python scripts/admin.py add-meta <tenant_id> act_123456 --token-prompt
  python scripts/admin.py list <tenant_id>
"""
import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env", encoding="utf-8-sig")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("gen-enc-key")
    p = sub.add_parser("create-tenant"); p.add_argument("name"); p.add_argument("--plan", default="free")
    p = sub.add_parser("create-key"); p.add_argument("tenant_id"); p.add_argument("label", nargs="?", default="default")
    p = sub.add_parser("add-meta"); p.add_argument("tenant_id"); p.add_argument("account")
    p = sub.add_parser("list"); p.add_argument("tenant_id")
    a = ap.parse_args()

    if a.cmd == "gen-enc-key":
        from cryptography.fernet import Fernet
        print(Fernet.generate_key().decode())
        return

    from store import get_store
    store = get_store()
    if a.cmd == "create-tenant":
        t = store.create_tenant(a.name, a.plan)
        print("tenant_id:", t.id)
    elif a.cmd == "create-key":
        print("API key (sirf abhi dikhegi, kahin safe rakho):")
        print(store.create_api_key(a.tenant_id, a.label))
    elif a.cmd == "add-meta":
        token = getpass.getpass("Meta access token paste karo (dikhega nahi): ").strip()
        acct = a.account if a.account.startswith("act_") else f"act_{a.account}"
        store.add_connection(a.tenant_id, "meta", acct, token)
        print("ok:", acct)
    elif a.cmd == "list":
        for c in store.list_connections(a.tenant_id):
            print(c)


if __name__ == "__main__":
    main()
