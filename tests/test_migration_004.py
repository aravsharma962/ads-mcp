"""Static checks on supabase/migrations/004_business_types.sql. Run: python tests/test_migration_004.py"""
import re
import subprocess
from pathlib import Path

MIG = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
sql = (MIG / "004_business_types.sql").read_text(encoding="utf-8").lower()
sql_nc = re.sub(r"--[^\n]*", "", sql)


def test_adds_business_type_column_with_default_and_check():
    m = re.search(r"alter table (?:public\.)?clients\s+add column (?:if not exists )?business_type\s+([^;]*);", sql_nc)
    assert m, "alter table clients add column business_type missing"
    col = m.group(1)
    assert re.match(r"text\b", col) and "not null" in col
    assert "default 'ecommerce'" in col
    chk = re.search(r"check\s*\(\s*business_type\s+in\s*\(([^)]*)\)\s*\)", col)
    assert chk, col
    assert sorted(re.findall(r"'([a-z0-9_]+)'", chk.group(1))) == ["ecommerce", "lead_gen", "saas_b2b"]


def test_no_destructive_statements():
    assert not re.search(r"\b(drop table|drop column|truncate|delete from)\b", sql_nc)


def test_earlier_migrations_untouched():
    out = subprocess.run(["git", "log", "--format=%H", "--", "supabase/migrations/001_init.sql",
                          "supabase/migrations/002_saas.sql", "supabase/migrations/003_saas_hardening.sql"],
                         cwd=MIG.parent.parent, capture_output=True, text=True).stdout.split()
    changed = subprocess.run(["git", "diff", "--name-only", "HEAD", "--", "supabase/migrations"],
                             cwd=MIG.parent.parent, capture_output=True, text=True).stdout.split()
    assert not any(re.search(r"/00[123]_", c) for c in changed), changed
    assert out, "history of 001-003 should exist"
    s2 = (MIG / "002_saas.sql").read_text(encoding="utf-8").lower()
    assert "business_type" not in s2 and "business_type" not in (MIG / "003_saas_hardening.sql").read_text(encoding="utf-8").lower()


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        fn()
        print("OK ", name)
print("\nALL TESTS PASSED")
