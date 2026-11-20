"""Static checks on supabase/migrations/002_saas.sql. Chalane ka: python tests/test_migration_002.py"""
import re
from pathlib import Path

SQL_PATH = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "002_saas.sql"
sql = SQL_PATH.read_text(encoding="utf-8").lower()
# comments hata do taaki unme likha text check ko na dhoke
sql_nc = re.sub(r"--[^\n]*", "", sql)
stmts = [s.strip() for s in sql_nc.split(";") if s.strip()]

TABLES = ["memberships", "clients", "client_accounts", "targets", "conversations", "messages",
          "usage_events", "insights_cache", "sites", "events"]
NO_POLICY = {"insights_cache"}          # sirf service role
POLICIES = [s for s in stmts if s.startswith("create policy")]


def policies_on(table):
    return [p for p in POLICIES if re.search(rf"\bon (public\.)?{table}\b", p)]


def test_tables_created():
    for t in TABLES:
        assert re.search(rf"create table (if not exists )?(public\.)?{t}\s*\(", sql_nc), t


def test_rls_enabled_everywhere():
    for t in TABLES:
        assert re.search(rf"alter table (public\.)?{t}\s+enable row level security", sql_nc), t


def test_tenant_scoped_tables_have_membership_policy():
    for t in TABLES:
        if t in NO_POLICY:
            assert not policies_on(t), f"{t} should have no client policies"
            continue
        ps = policies_on(t)
        assert ps, t
        assert any("memberships" in p and "auth.uid()" in p for p in ps), t


def test_no_anon_or_public_policy():
    assert POLICIES
    for p in POLICIES:
        assert "to authenticated" in p, p[:80]
        assert not re.search(r"\bto\s+(anon|public)\b", p), p[:80]
        assert "using (true)" not in p and "with check (true)" not in p, p[:80]
    assert not re.search(r"grant\s+[^;]*\bto\s+anon\b", sql_nc)


def test_service_role_grants():
    assert re.search(r"grant [^;]*to service_role", sql_nc)


def test_owner_only_writes_and_events_service_only():
    for t in ("clients", "client_accounts", "sites"):
        for p in policies_on(t):
            if re.search(r"\bfor (insert|delete)\b", p):
                assert "'owner'" in p, p[:90]
        kinds = {m for p in policies_on(t) for m in re.findall(r"\bfor (insert|delete)\b", p)}
        assert kinds == {"insert", "delete"}, (t, kinds)
    for p in policies_on("targets"):
        if re.search(r"\bfor (insert|update)\b", p):
            assert "'owner'" not in p          # members may edit targets
    assert {m for p in policies_on("targets") for m in re.findall(r"\bfor (insert|update)\b", p)} == {"insert", "update"}
    for t in ("events", "usage_events"):
        assert all(re.search(r"\bfor select\b", p) for p in policies_on(t)), t


def test_schema_details():
    assert "check (role in ('owner','member'))" in sql_nc.replace(" ", "").replace("check(role", "check (role") \
        or re.search(r"role\s+text[^,]*check\s*\(\s*role\s+in\s*\(\s*'owner'\s*,\s*'member'\s*\)\s*\)", sql_nc)
    assert re.search(r"roas_source\s+text[^,]*default\s+'tracking'", sql_nc)
    assert "'{purchase,form_submit}'" in sql_nc
    assert re.search(r"site_key\s+text[^,]*unique", sql_nc)
    assert "primary key (client_id, platform, external_id)" in sql_nc
    assert "primary key (client_id, metric)" in sql_nc
    assert "on delete cascade" in sql_nc


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
