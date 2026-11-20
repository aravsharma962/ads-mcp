"""Data store: InMemoryStore (test/local) aur SupabaseStore (asli)."""
import os
import threading
import uuid
from datetime import datetime, timezone

import functools

import httpx

from crypto import decrypt, encrypt
from tenancy import Tenant, hash_key, new_api_key


_DB_LOCK = threading.RLock()


def db_call(retry: bool):
    """Supabase calls ek-ek karke (HTTP/2 connection thread-safe nahi). retry=True: padhne/idempotent calls
    connection reset (RemoteProtocolError/StreamReset) par ek baar dobara. Writes kabhi retry nahi."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            with _DB_LOCK:
                try:
                    return fn(*a, **kw)
                except httpx.TransportError:
                    if not retry:
                        raise
                    return fn(*a, **kw)
        return wrapper
    return deco


class InMemoryStore:
    """Sirf test/local ke liye. Restart par sab ud jaata hai."""

    def __init__(self):
        self._lock = threading.Lock()
        self.tenants: dict[str, dict] = {}
        self.keys: list[dict] = []
        self.conns: list[dict] = []
        self.audit: list[dict] = []

    def create_tenant(self, name: str, plan: str = "free") -> Tenant:
        tid = str(uuid.uuid4())
        self.tenants[tid] = {"id": tid, "name": name, "plan": plan}
        return Tenant(tid, name, plan)

    def create_api_key(self, tenant_id: str, label: str = "default") -> str:
        raw = new_api_key()
        self.keys.append({"id": str(uuid.uuid4()), "tenant_id": tenant_id, "label": label,
                          "key_hash": hash_key(raw), "created_at": datetime.now(timezone.utc).isoformat(),
                          "revoked_at": None})
        return raw

    def list_tenants(self) -> list[dict]:
        return [{"id": t["id"], "name": t["name"], "plan": t["plan"]} for t in reversed(list(self.tenants.values()))]

    def get_tenant(self, tenant_id: str) -> dict | None:
        t = self.tenants.get(tenant_id)
        return {"id": t["id"], "name": t["name"], "plan": t["plan"]} if t else None

    def list_keys(self, tenant_id: str) -> list[dict]:
        return [{"id": k["id"], "label": k["label"], "created_at": k["created_at"], "revoked_at": k["revoked_at"]}
                for k in self.keys if k["tenant_id"] == tenant_id]

    def revoke_key_by_id(self, tenant_id: str, key_id: str) -> bool:
        for k in self.keys:
            if k["id"] == key_id and k["tenant_id"] == tenant_id and not k["revoked_at"]:
                k["revoked_at"] = datetime.now(timezone.utc).isoformat()
                return True
        return False

    def delete_connection(self, tenant_id: str, platform: str, external_id: str) -> bool:
        before = len(self.conns)
        self.conns = [c for c in self.conns if not (
            c["tenant_id"] == tenant_id and c["platform"] == platform and c["external_id"] == external_id)]
        return len(self.conns) < before

    def revoke_api_key(self, raw: str) -> None:
        h = hash_key(raw)
        for k in self.keys:
            if k["key_hash"] == h:
                k["revoked_at"] = datetime.now(timezone.utc).isoformat()

    def resolve_api_key(self, raw: str) -> Tenant | None:
        h = hash_key(raw)
        for k in self.keys:
            if k["key_hash"] == h and not k["revoked_at"]:
                t = self.tenants[k["tenant_id"]]
                return Tenant(t["id"], t["name"], t["plan"], k["label"] or "")
        return None

    def add_connection(self, tenant_id: str, platform: str, external_id: str, token: str) -> None:
        self.conns = [c for c in self.conns if not (
            c["tenant_id"] == tenant_id and c["platform"] == platform and c["external_id"] == external_id)]
        self.conns.append({"tenant_id": tenant_id, "platform": platform, "external_id": external_id,
                           "token_enc": encrypt(token)})

    def list_connections(self, tenant_id: str) -> list[dict]:
        return [{"platform": c["platform"], "external_id": c["external_id"]}
                for c in self.conns if c["tenant_id"] == tenant_id]

    def get_token(self, tenant_id: str, platform: str, external_id: str) -> str | None:
        # Ownership check: tenant_id filter ke bina koi row nahi milti.
        for c in self.conns:
            if (c["tenant_id"] == tenant_id and c["platform"] == platform
                    and c["external_id"] == external_id):
                return decrypt(c["token_enc"])
        return None

    def log_audit(self, tenant_id: str, actor: str, tool: str, args: dict, result: str) -> None:
        self.audit.append({"tenant_id": tenant_id, "actor": actor, "tool": tool,
                           "args_redacted": args, "result": result})


class SupabaseStore:
    """Asli store. SUPABASE_URL aur SUPABASE_SERVICE_ROLE_KEY chahiye (service role sirf server par)."""

    def __init__(self):
        from supabase import ClientOptions, create_client
        url, key = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        try:
            # HTTP/2 serverless (Vercel) par StreamReset deta hai, isliye HTTP/1.1.
            self.db = create_client(url, key, options=ClientOptions(httpx_client=httpx.Client(http2=False)))
        except TypeError:          # purana supabase version jisme httpx_client option nahi
            self.db = create_client(url, key)

    @db_call(retry=False)
    def create_tenant(self, name: str, plan: str = "free") -> Tenant:
        r = self.db.table("tenants").insert({"name": name, "plan": plan}).execute().data[0]
        return Tenant(r["id"], r["name"], r["plan"])

    @db_call(retry=False)
    def create_api_key(self, tenant_id: str, label: str = "default") -> str:
        raw = new_api_key()
        self.db.table("api_keys").insert(
            {"tenant_id": tenant_id, "label": label, "key_hash": hash_key(raw)}).execute()
        return raw

    @db_call(retry=True)
    def list_tenants(self) -> list[dict]:
        return (self.db.table("tenants").select("id, name, plan").order("created_at", desc=True).execute().data)

    @db_call(retry=True)
    def get_tenant(self, tenant_id: str) -> dict | None:
        rows = self.db.table("tenants").select("id, name, plan").eq("id", tenant_id).limit(1).execute().data
        return rows[0] if rows else None

    @db_call(retry=True)
    def list_keys(self, tenant_id: str) -> list[dict]:
        return (self.db.table("api_keys").select("id, label, created_at, revoked_at")
                .eq("tenant_id", tenant_id).order("created_at", desc=True).execute().data)

    @db_call(retry=False)
    def revoke_key_by_id(self, tenant_id: str, key_id: str) -> bool:
        rows = (self.db.table("api_keys").update({"revoked_at": datetime.now(timezone.utc).isoformat()})
                .eq("tenant_id", tenant_id).eq("id", key_id).is_("revoked_at", "null").execute().data)
        return bool(rows)

    @db_call(retry=False)
    def delete_connection(self, tenant_id: str, platform: str, external_id: str) -> bool:
        rows = (self.db.table("ad_connections").delete().eq("tenant_id", tenant_id)
                .eq("platform", platform).eq("external_id", external_id).execute().data)
        return bool(rows)

    @db_call(retry=False)
    def revoke_api_key(self, raw: str) -> None:
        self.db.table("api_keys").update({"revoked_at": datetime.now(timezone.utc).isoformat()}) \
            .eq("key_hash", hash_key(raw)).execute()

    @db_call(retry=True)
    def resolve_api_key(self, raw: str) -> Tenant | None:
        rows = (self.db.table("api_keys").select("label, tenants(id, name, plan)")
                .eq("key_hash", hash_key(raw)).is_("revoked_at", "null").limit(1).execute().data)
        if not rows or not rows[0].get("tenants"):
            return None
        t = rows[0]["tenants"]
        return Tenant(t["id"], t["name"], t["plan"], rows[0].get("label") or "")

    @db_call(retry=True)
    def add_connection(self, tenant_id: str, platform: str, external_id: str, token: str) -> None:
        self.db.table("ad_connections").upsert(
            {"tenant_id": tenant_id, "platform": platform, "external_id": external_id,
             "token_enc": encrypt(token)},
            on_conflict="tenant_id,platform,external_id").execute()

    @db_call(retry=True)
    def list_connections(self, tenant_id: str) -> list[dict]:
        return (self.db.table("ad_connections").select("platform, external_id")
                .eq("tenant_id", tenant_id).execute().data)

    @db_call(retry=True)
    def get_token(self, tenant_id: str, platform: str, external_id: str) -> str | None:
        rows = (self.db.table("ad_connections").select("token_enc")
                .eq("tenant_id", tenant_id).eq("platform", platform)
                .eq("external_id", external_id).limit(1).execute().data)
        return decrypt(rows[0]["token_enc"]) if rows else None

    @db_call(retry=False)
    def log_audit(self, tenant_id: str, actor: str, tool: str, args: dict, result: str) -> None:
        self.db.table("audit_log").insert({"tenant_id": tenant_id, "actor": actor, "tool": tool,
                                           "args_redacted": args, "result": result}).execute()


_store = None


def get_store():
    global _store
    if _store is None:
        _store = InMemoryStore() if os.environ.get("STORE") == "memory" else SupabaseStore()
    return _store
