"""Static checks on supabase/migrations/003_saas_hardening.sql. Chalane ka: python tests/test_migration_003.py"""
import re
from pathlib import Path

MIG = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
sql = (MIG / "003_saas_hardening.sql").read_text(encoding="utf-8").lower()
sql_nc = re.sub(r"--[^\n]*", "", sql)
stmts = [s.strip() for s in sql_nc.split(";") if s.strip()]
creates = [s for s in stmts if s.startswith("create policy")]
drops = [s for s in stmts if s.startswith("drop policy")]


def dropped(name):
    return any(re.search(rf"\b{name}\b", d) for d in drops)


def created(name):
    return [c for c in creates if re.search(rf"create policy {name}\b", c)]


def test_002_is_untouched_history():
    assert "messages_insert" in (MIG / "002_saas.sql").read_text(encoding="utf-8").lower()


def test_messages_direct_insert_removed():
    assert dropped("messages_insert")
    assert not created("messages_insert")
    assert not any(re.search(r"\bon (public\.)?messages\b", c) and re.search(r"\bfor insert\b", c) for c in creates)
    assert re.search(r"revoke\s+insert\s+on\s+[^;]*\bmessages\b[^;]*from authenticated", sql_nc)


def test_client_accounts_and_sites_direct_insert_removed():
    for name in ("client_accounts_insert_owner", "sites_insert_owner"):
        assert dropped(name), name
        assert not created(name), name
    assert not any(re.search(r"\bon (public\.)?(client_accounts|sites)\b", c) and re.search(r"\bfor insert\b", c) for c in creates)
    assert re.search(r"revoke\s+insert\s+on\s+[^;]*\bclient_accounts\b[^;]*from authenticated", sql_nc)
    assert re.search(r"revoke\s+insert\s+on\s+[^;]*\bsites\b[^;]*from authenticated", sql_nc)


def test_conversations_and_messages_read_limited_to_creator():
    assert dropped("conversations_select") and dropped("messages_select")
    c = created("conversations_select")
    m = created("messages_select")
    assert len(c) == 1 and len(m) == 1
    assert "user_id = auth.uid()" in c[0] and "memberships" in c[0]
    assert "user_id = auth.uid()" in m[0] and "conversations" in m[0]


def test_new_policies_stay_authenticated_only():
    for p in creates:
        assert "to authenticated" in p, p[:80]
        assert "using (true)" not in p and "with check (true)" not in p


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
