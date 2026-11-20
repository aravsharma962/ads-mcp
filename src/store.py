"""Data store: InMemoryStore (test/local) aur SupabaseStore (asli)."""
import os
import threading
import uuid
from datetime import datetime, timezone

from crypto import decrypt, encrypt
from tenancy import Tenant, hash_key, new_api_key


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
        self.keys.append({"tenant_id": tenant_id, "label": label, "key_hash": hash_key(raw), "revoked_at": None})
        return raw

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
        from supabase import create_client
        self.db = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    def create_tenant(self, name: str, plan: str = "free") -> Tenant:
        r = self.db.table("tenants").insert({"name": name, "plan": plan}).execute().data[0]
        return Tenant(r["id"], r["name"], r["plan"])

    def create_api_key(self, tenant_id: str, label: str = "default") -> str:
        raw = new_api_key()
        self.db.table("api_keys").insert(
            {"tenant_id": tenant_id, "label": label, "key_hash": hash_key(raw)}).execute()
        return raw

    def revoke_api_key(self, raw: str) -> None:
        self.db.table("api_keys").update({"revoked_at": datetime.now(timezone.utc).isoformat()}) \
            .eq("key_hash", hash_key(raw)).execute()

    def resolve_api_key(self, raw: str) -> Tenant | None:
        rows = (self.db.table("api_keys").select("label, tenants(id, name, plan)")
                .eq("key_hash", hash_key(raw)).is_("revoked_at", "null").limit(1).execute().data)
        if not rows or not rows[0].get("tenants"):
            return None
        t = rows[0]["tenants"]
        return Tenant(t["id"], t["name"], t["plan"], rows[0].get("label") or "")

    def add_connection(self, tenant_id: str, platform: str, external_id: str, token: str) -> None:
        self.db.table("ad_connections").upsert(
            {"tenant_id": tenant_id, "platform": platform, "external_id": external_id,
             "token_enc": encrypt(token)},
            on_conflict="tenant_id,platform,external_id").execute()

    def list_connections(self, tenant_id: str) -> list[dict]:
        return (self.db.table("ad_connections").select("platform, external_id")
                .eq("tenant_id", tenant_id).execute().data)

    def get_token(self, tenant_id: str, platform: str, external_id: str) -> str | None:
        rows = (self.db.table("ad_connections").select("token_enc")
                .eq("tenant_id", tenant_id).eq("platform", platform)
                .eq("external_id", external_id).limit(1).execute().data)
        return decrypt(rows[0]["token_enc"]) if rows else None

    def log_audit(self, tenant_id: str, actor: str, tool: str, args: dict, result: str) -> None:
        self.db.table("audit_log").insert({"tenant_id": tenant_id, "actor": actor, "tool": tool,
                                           "args_redacted": args, "result": result}).execute()


_store = None


def get_store():
    global _store
    if _store is None:
        _store = InMemoryStore() if os.environ.get("STORE") == "memory" else SupabaseStore()
    return _store
