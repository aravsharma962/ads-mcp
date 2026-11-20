"""Admin auth helpers. Chalane ka: python tests/test_admin_auth.py"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import admin_auth as A  # noqa: E402

H8 = 8 * 3600


def setenv(pw="pw-test-long-enough-123", secret=None):
    os.environ.pop("ADMIN_PASSWORD", None)
    os.environ.pop("ADMIN_SESSION_SECRET", None)
    if pw is not None:
        os.environ["ADMIN_PASSWORD"] = pw
    if secret is not None:
        os.environ["ADMIN_SESSION_SECRET"] = secret


def test_disabled_when_unset():
    setenv(None)
    assert A.admin_enabled() is False
    setenv("")
    assert A.admin_enabled() is False
    setenv("   ")
    assert A.admin_enabled() is False
    setenv("short-pw-14chr")            # 13 chars < 16
    assert A.admin_enabled() is False
    setenv("sixteen-chars-ok!")
    assert A.admin_enabled() is True


def test_check_password_right_and_wrong():
    setenv("pw-test-long-enough-123")
    assert A.check_password("pw-test-long-enough-123") is True
    assert A.check_password("pw-tesT") is False
    assert A.check_password("") is False
    setenv(None)
    assert A.check_password("") is False and A.check_password("anything") is False


def test_session_roundtrip():
    setenv("pw-test-long-enough-123")
    assert A.verify_session(A.make_session(now=1000.0), now=1001.0) is True


def test_session_expired_after_8h():
    setenv("pw-test-long-enough-123")
    c = A.make_session(now=1000.0)
    assert A.verify_session(c, now=1000.0 + H8 - 1) is True
    assert A.verify_session(c, now=1000.0 + H8 + 1) is False


def test_session_tampered_signature_and_expiry_rejected():
    setenv("pw-test-long-enough-123")
    c = A.make_session(now=1000.0)
    exp, sig = c.split(".")
    assert A.verify_session(f"{exp}.{sig[:-1]}{'0' if sig[-1] != '0' else '1'}", now=1001.0) is False
    assert A.verify_session(f"{int(exp) + 99999}.{sig}", now=1001.0) is False


def test_session_with_other_secret_rejected():
    setenv("pw-test-long-enough-123", secret="secret-one-very-long-xxxxxxxxxxxxxxxx")
    c = A.make_session(now=1000.0)
    setenv("pw-test-long-enough-123", secret="secret-two-very-long-xxxxxxxxxxxxxxxx")
    assert A.verify_session(c, now=1001.0) is False


def test_session_invalid_when_disabled():
    setenv("pw-test-long-enough-123")
    c = A.make_session(now=1000.0)
    setenv(None)
    assert A.verify_session(c, now=1001.0) is False


def test_garbage_cookie_values_rejected():
    setenv("pw-test-long-enough-123")
    for bad in ["", "nodot", "abc.def", ".", "123.", ".abc", "1.2.3", None]:
        assert A.verify_session(bad, now=1001.0) is False, bad


def test_non_ascii_or_wrong_length_signature_is_false_not_500():
    setenv("pw-test-long-enough-123")
    for bad in ["123.é", "123." + "a" * 63, "123." + "g" * 64, "123." + "A" * 64]:
        assert A.verify_session(bad, now=1.0) is False, bad


def test_limiter_global_cap_and_memory_cap():
    lim = A.LoginLimiter()
    for i in range(A.GLOBAL_MAX_FAILS):
        lim.fail(f"10.0.{i // 250}.{i % 250}", now=100.0)       # har IP ek hi fail
    assert lim.allowed("9.9.9.9", now=101.0) is False             # naya IP bhi roka gaya
    assert lim.allowed("9.9.9.9", now=100.0 + 15 * 60 + 1) is True
    lim2 = A.LoginLimiter()
    for i in range(A.MAX_TRACKED_IPS + 500):
        lim2.fail(f"ip-{i}", now=100.0)
    assert len(lim2._fails) <= A.MAX_TRACKED_IPS


def test_limiter_blocks_after_5_fails_and_recovers_after_15min():
    lim = A.LoginLimiter()
    t = 5000.0
    for _ in range(5):
        assert lim.allowed("1.1.1.1", now=t) is True
        lim.fail("1.1.1.1", now=t)
    assert lim.allowed("1.1.1.1", now=t + 1) is False
    assert lim.allowed("2.2.2.2", now=t + 1) is True       # doosre IP par asar nahi
    assert lim.allowed("1.1.1.1", now=t + 15 * 60 + 1) is True
    lim.reset("1.1.1.1")
    assert lim.allowed("1.1.1.1", now=t + 2) is True


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK ", name)
    print("ALL TESTS PASSED")
