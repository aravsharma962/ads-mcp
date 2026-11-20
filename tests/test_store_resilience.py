"""SupabaseStore ke calls serialize hon + padhne wale calls retry hon. Chalane ka: python tests/test_store_resilience.py"""
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()

import httpx  # noqa: E402
from store import db_call  # noqa: E402


class Fake:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = 0
        self.active = 0
        self.max_active = 0

    @db_call(retry=True)
    def read_flaky(self):
        self.calls += 1
        if self.calls == 1:
            raise httpx.RemoteProtocolError("StreamReset")
        return "ok"

    @db_call(retry=True)
    def read_always_fails(self):
        self.calls += 1
        raise httpx.RemoteProtocolError("StreamReset")

    @db_call(retry=False)
    def write_flaky(self):
        self.calls += 1
        raise httpx.RemoteProtocolError("StreamReset")

    @db_call(retry=True)
    def slow(self):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        time.sleep(0.05)
        self.active -= 1
        return 1


def test_read_retries_once_then_succeeds():
    f = Fake()
    assert f.read_flaky() == "ok" and f.calls == 2


def test_read_gives_up_after_one_retry():
    f = Fake()
    try:
        f.read_always_fails()
        assert False, "error aana chahiye tha"
    except httpx.RemoteProtocolError:
        assert f.calls == 2


def test_write_never_retried():
    f = Fake()
    try:
        f.write_flaky()
        assert False
    except httpx.RemoteProtocolError:
        assert f.calls == 1


def test_non_transport_errors_not_retried():
    f = Fake()

    class Boom(Fake):
        @db_call(retry=True)
        def bad(self):
            self.calls += 1
            raise ValueError("x")
    b = Boom()
    try:
        b.bad()
        assert False
    except ValueError:
        assert b.calls == 1


def test_calls_do_not_overlap_across_threads():
    f = Fake()
    ts = [threading.Thread(target=f.slow) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert f.max_active == 1, f.max_active


def test_supabase_store_uses_http1_not_http2():
    os.environ["SUPABASE_URL"] = "https://abcdefghijklmnop.supabase.co"
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "a.b.c"
    from store import SupabaseStore
    pool = SupabaseStore().db.postgrest.session._transport._pool
    assert pool._http2 is False, "HTTP/2 band hona chahiye (Vercel par StreamReset deta hai)"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK ", name)
    print("ALL TESTS PASSED")
