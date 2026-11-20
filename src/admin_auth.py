"""Admin panel auth: ADMIN_PASSWORD + signed cookie + login rate limit. Sirf stdlib."""
import hashlib
import hmac
import os
import re
import threading
import time

SESSION_SECONDS = 8 * 3600
MAX_FAILS = 5
GLOBAL_MAX_FAILS = 50          # saare IP milakar: spoofed IP se brute force roakne ke liye
MAX_TRACKED_IPS = 10_000
WINDOW_SECONDS = 15 * 60
MIN_PASSWORD_LEN = 16
_SIG_RE = re.compile(r"^[0-9a-f]{64}$")


def _password() -> str:
    return os.environ.get("ADMIN_PASSWORD", "").strip()


def admin_enabled() -> bool:
    """Password set ho aur kam se kam 16 characters ka ho, warna panel band."""
    return len(_password()) >= MIN_PASSWORD_LEN


def check_password(candidate: str) -> bool:
    pw = _password()
    if not pw or not isinstance(candidate, str):
        return False
    return hmac.compare_digest(candidate.encode(), pw.encode())


def _key() -> bytes:
    secret = os.environ.get("ADMIN_SESSION_SECRET", "").strip()
    return (secret or hashlib.sha256(("session:" + _password()).encode()).hexdigest()).encode()


def _sign(exp: str) -> str:
    return hmac.new(_key(), exp.encode(), hashlib.sha256).hexdigest()


def make_session(now: float | None = None) -> str:
    exp = str(int((time.time() if now is None else now) + SESSION_SECONDS))
    return f"{exp}.{_sign(exp)}"


def verify_session(value, now: float | None = None) -> bool:
    if not admin_enabled() or not isinstance(value, str):
        return False
    parts = value.split(".")
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1]:
        return False
    exp, sig = parts
    if not _SIG_RE.match(sig):
        return False
    if not hmac.compare_digest(sig, _sign(exp)):
        return False
    return (time.time() if now is None else now) < int(exp)


class LoginLimiter:
    """IP ke hisaab se galat password ginti. Serverless me har instance ka apna count (best-effort)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._fails: dict[str, list[float]] = {}
        self._global: list[float] = []

    def _recent(self, ip: str, now: float) -> list[float]:
        recent = [t for t in self._fails.get(ip, []) if now - t < WINDOW_SECONDS]
        self._fails[ip] = recent
        return recent

    def _recent_global(self, now: float) -> list[float]:
        self._global = [t for t in self._global if now - t < WINDOW_SECONDS]
        return self._global

    def allowed(self, ip: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            return len(self._recent(ip, now)) < MAX_FAILS and len(self._recent_global(now)) < GLOBAL_MAX_FAILS

    def fail(self, ip: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            self._recent(ip, now).append(now)
            self._recent_global(now).append(now)
            while len(self._fails) > MAX_TRACKED_IPS:      # memory cap: sabse purana IP hatao
                self._fails.pop(next(iter(self._fails)))

    def reset(self, ip: str) -> None:
        with self._lock:
            self._fails.pop(ip, None)


limiter = LoginLimiter()
