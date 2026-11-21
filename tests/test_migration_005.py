"""Static checks on supabase/migrations/005_actions.sql. Run: python tests/test_migration_005.py"""
import re
from pathlib import Path

MIG = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
sql = (MIG / "005_actions.sql").read_text(encoding="utf-8").lower()
sql_nc = re.sub(r"--[^\n]*", "", sql)
stmts = [s.strip() for s in sql_nc.split(";") if s.strip()]
POLICIES = [s for s in stmts if s.startswith("create policy")]
LM_POLICIES = [p for p in POLICIES if re.search(r"\bon (public\.)?lead_marks\b", p)]
TENANT = r"client_id in \(select id from (public\.)?clients where tenant_id in\s*\(select tenant_id from (public\.)?memberships where user_id = auth\.uid\(\)\)\)"


def test_action_rules_column():
    m = re.search(r"alter table (?:public\.)?clients\s+add column if not exists action_rules\s+([^;]*);", sql_nc)
    assert m, "action_rules column missing"
    col = re.sub(r"\s+", " ", m.group(1))
    assert col.startswith("jsonb") and "not null" in col and "default '{}'::jsonb" in col


def test_lead_marks_table():
    m = re.search(r"create table if not exists (?:public\.)?lead_marks\s*\((.*?)\)\s*$", next(s for s in stmts if "create table" in s and "lead_marks" in s), re.S)
    assert m, "lead_marks table missing"
    body = re.sub(r"\s+", " ", m.group(1))
    assert "client_id uuid not null references clients(id) on delete cascade" in body or "client_id uuid references clients(id) on delete cascade" in body
    assert "session_id text not null" in body
    chk = re.search(r"status text not null check \(status in \(([^)]*)\)\)", body)
    assert chk, body
    assert sorted(re.findall(r"'([a-z]+)'", chk.group(1))) == ["lost", "new", "qualified", "won"]
    assert "updated_at timestamptz not null default now()" in body
    assert "primary key (client_id, session_id)" in body


def test_rls_enabled():
    assert re.search(r"alter table (public\.)?lead_marks\s+enable row level security", sql_nc)


def test_policies_select_insert_update_tenant_scoped():
    kinds = {}
    for p in LM_POLICIES:
        assert "to authenticated" in p, p
        assert re.search(TENANT, re.sub(r"\s+", " ", p).replace("( ", "(")) or re.search(TENANT, p), p
        k = re.search(r"\bfor (select|insert|update|delete|all)\b", p).group(1)
        kinds[k] = p
    assert set(kinds) == {"select", "insert", "update"}, kinds.keys()
    assert "using" in kinds["select"] and "with check" in kinds["insert"]
    assert "using" in kinds["update"] and "with check" in kinds["update"]


def test_policies_idempotent():
    for p in LM_POLICIES:
        name = re.search(r"create policy (\w+)", p).group(1)
        assert re.search(rf"drop policy if exists {name} on (public\.)?lead_marks", sql_nc), name


def test_grants():
    assert re.search(r"grant select, insert, update on (public\.)?lead_marks to authenticated", sql_nc)
    assert not re.search(r"grant[^;]*\bdelete\b[^;]*lead_marks[^;]*authenticated", sql_nc)
    assert re.search(r"grant select, insert, update, delete on (public\.)?lead_marks to service_role", sql_nc)
    assert not re.search(r"\bto (anon|public)\b", sql_nc)


def test_events_index():
    assert re.search(r"create index if not exists \w+\s+on (public\.)?events\s*\(client_id, name, ts desc\)", sql_nc)


def test_no_destructive_statements():
    assert not re.search(r"\b(drop table|drop column|truncate|delete from)\b", sql_nc)


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
