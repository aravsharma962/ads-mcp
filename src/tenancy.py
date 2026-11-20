"""Tenant = ek agency/client. Tenant HAMESHA API key se pata chalta hai, kisi tool argument se kabhi nahi."""
import contextvars
import hashlib
import secrets
from dataclasses import dataclass


@dataclass(frozen=True)
class Tenant:
    id: str
    name: str
    plan: str
    key_label: str = ""


_current: contextvars.ContextVar[Tenant | None] = contextvars.ContextVar("tenant", default=None)


def hash_key(raw_key: str) -> str:
    # API key lambi aur random hai, isliye sha256 kaafi hai (password jaisa slow hash zaroori nahi).
    return hashlib.sha256(raw_key.encode()).hexdigest()


def new_api_key() -> str:
    return "adsmcp_" + secrets.token_urlsafe(32)


def set_current(tenant: Tenant):
    return _current.set(tenant)


def reset_current(token) -> None:
    _current.reset(token)


def current_tenant() -> Tenant:
    t = _current.get()
    if t is None:
        raise PermissionError("Authenticated tenant nahi mila")
    return t


def norm_account(external_id: str) -> str:
    external_id = external_id.strip()
    return external_id if external_id.startswith("act_") else f"act_{external_id}"
