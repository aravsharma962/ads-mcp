"""Store admin methods (InMemoryStore). Chalane ka: python tests/test_store_admin.py"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()

from store import InMemoryStore  # noqa: E402


def fresh():
    s = InMemoryStore()
    a = s.create_tenant("Agency A")
    b = s.create_tenant("Agency B")
    return s, a, b


def test_list_tenants_and_get():
    s, a, b = fresh()
    ids = [t["id"] for t in s.list_tenants()]
    assert set(ids) == {a.id, b.id} and ids[0] == b.id  # newest first
    assert s.get_tenant(a.id) == {"id": a.id, "name": "Agency A", "plan": "free"}
    assert s.get_tenant("nope") is None


def test_list_keys_hides_hash_and_shows_revoked():
    s, a, _ = fresh()
    raw = s.create_api_key(a.id, "desk")
    keys = s.list_keys(a.id)
    assert len(keys) == 1 and set(keys[0]) == {"id", "label", "created_at", "revoked_at"}
    assert keys[0]["label"] == "desk" and keys[0]["revoked_at"] is None
    assert s.revoke_key_by_id(a.id, keys[0]["id"]) is True
    assert s.list_keys(a.id)[0]["revoked_at"] is not None
    assert s.resolve_api_key(raw) is None


def test_revoke_by_id_wrong_tenant_false_and_key_still_works():
    s, a, b = fresh()
    raw = s.create_api_key(a.id, "desk")
    kid = s.list_keys(a.id)[0]["id"]
    assert s.revoke_key_by_id(b.id, kid) is False
    assert s.resolve_api_key(raw) is not None
    assert s.revoke_key_by_id(a.id, "unknown-id") is False


def test_revoke_twice_second_false():
    s, a, _ = fresh()
    s.create_api_key(a.id, "desk")
    kid = s.list_keys(a.id)[0]["id"]
    assert s.revoke_key_by_id(a.id, kid) is True
    assert s.revoke_key_by_id(a.id, kid) is False


def test_delete_connection_wrong_tenant_false_and_token_still_readable():
    s, a, b = fresh()
    s.add_connection(a.id, "meta", "act_1", "TOK")
    assert s.delete_connection(b.id, "meta", "act_1") is False
    assert s.get_token(a.id, "meta", "act_1") == "TOK"


def test_delete_connection_removes():
    s, a, _ = fresh()
    s.add_connection(a.id, "meta", "act_1", "TOK")
    assert s.delete_connection(a.id, "meta", "act_1") is True
    assert s.list_connections(a.id) == []
    assert s.delete_connection(a.id, "meta", "act_1") is False


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK ", name)
    print("ALL TESTS PASSED")
