"""Static checks on supabase/migrations/006_action_log.sql. Run: python tests/test_migration_006.py"""
import re
from pathlib import Path

MIG = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
sql = (MIG / "006_action_log.sql").read_text(encoding="utf-8").lower()
sql_nc = re.sub(r"--[^\n]*", "", sql)
stmts = [re.sub(r"\s+", " ", s.strip()).replace("( ", "(").replace(" )", ")") for s in sql_nc.split(";") if s.strip()]
POLICIES = [s for s in stmts if s.startswith("create policy")]
AL_POLICIES = [p for p in POLICIES if re.search(r"\bon (public\.)?action_log\b", p)]
MEMBER = r"tenant_id in \(select tenant_id from (public\.)?memberships where user_id = auth\.uid\(\)\)"


def table_body():
    s = next((s for s in stmts if s.startswith("create table") and "action_log" in s), None)
    assert s, "action_log table missing"
    assert s.startswith("create table if not exists"), s
    return re.search(r"action_log\s*\((.*)\)$", s).group(1)


def test_table_columns():
    b = table_body()
    assert "id uuid primary key default gen_random_uuid()" in b
    assert "tenant_id uuid not null references tenants(id) on delete cascade" in b
    assert "client_id uuid not null references clients(id) on delete cascade" in b
    assert re.search(r"user_id uuid(,|$)", b), "user_id must be a plain nullable uuid"
    assert "ad_id text not null" in b
    assert re.search(r"ad_name text(,|$)", b)
    assert "object_id text not null" in b
    assert "before jsonb not null default '{}'::jsonb" in b
    assert "after jsonb not null default '{}'::jsonb" in b
    assert re.search(r"error text(,|$)", b)
    assert "created_at timestamptz not null default now()" in b


def check_values(col, expected):
    m = re.search(rf"{col} text check \({col} in \(([^)]*)\)\)", table_body())
    assert m, f"{col} check missing"
    assert sorted(re.findall(r"'([a-z]+)'", m.group(1))) == sorted(expected)


def test_checks():
    check_values("action", ["pause", "scale", "resume"])
    check_values("level", ["ad", "adset", "campaign"])
    check_values("status", ["pending", "ok", "error", "unknown"])


def test_index():
    assert re.search(r"create index if not exists \w+ on (public\.)?action_log \(?client_id, created_at desc\)?", " ".join(stmts))


def test_rls_enabled():
    assert re.search(r"alter table (public\.)?action_log enable row level security", sql_nc.replace("\n", " ") and re.sub(r"\s+", " ", sql_nc))


def test_only_select_policy():
    kinds = {}
    for p in AL_POLICIES:
        assert "to authenticated" in p, p
        assert not re.search(r"\bto (anon|public)\b", p)
        k = re.search(r"\bfor (select|insert|update|delete|all)\b", p).group(1)
        assert k not in kinds, f"duplicate {k} policy"
        kinds[k] = p
    assert set(kinds) == {"select"}, kinds.keys()


def test_select_tenant_scoped():
    p = next(p for p in AL_POLICIES if " for select " in p)
    assert "using" in p and re.search(MEMBER, p), p
    assert "with check" not in p


def test_no_authenticated_insert_anywhere():
    flat = re.sub(r"\s+", " ", sql_nc)
    assert not re.search(r"create policy \w+ on (public\.)?action_log for insert", flat)
    assert not re.search(r"grant[^;]*\binsert\b[^;]*action_log[^;]*authenticated", flat)
    assert "action_log_insert" in flat  # only as a drop of the old policy
    assert re.search(r"drop policy if exists action_log_insert on (public\.)?action_log", flat)


def test_pending_unique_index():
    flat = " ".join(stmts)
    assert re.search(r"create unique index if not exists action_log_pending_uq on (public\.)?action_log \(client_id, object_id\) where status = 'pending'", flat), flat


def test_policies_idempotent():
    assert AL_POLICIES
    for p in AL_POLICIES:
        name = re.search(r"create policy (\w+)", p).group(1)
        assert re.search(rf"drop policy if exists {name} on (public\.)?action_log", sql_nc), name


def test_grants():
    flat = re.sub(r"\s+", " ", sql_nc)
    assert re.search(r"grant select on (public\.)?action_log to authenticated", flat)
    assert not re.search(r"grant[^;]*\b(update|delete|all)\b[^;]*action_log[^;]*authenticated", flat)
    assert re.search(r"grant select, insert, update, delete on (public\.)?action_log to service_role", flat)
    assert not re.search(r"\bto (anon|public)\b", flat)


def test_no_destructive_statements():
    assert not re.search(r"\b(drop table|drop column|truncate|delete from)\b", sql_nc)


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
