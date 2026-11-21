"""Data store: InMemoryStore (test/local) aur SupabaseStore (asli)."""
import os
import threading
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

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


DEFAULT_CONVERSION_EVENTS = ["purchase", "form_submit"]
EVENT_FIELDS = "session_id, name, campaign_id, adset_id, ad_id, value, ts"


def date_bounds(date_from: str, date_to: str, tz_name: str | None) -> tuple[datetime, datetime]:
    """[start, end) UTC datetimes: date_from 00:00 se date_to ke poore din tak, client ke timezone mein."""
    try:
        tz = ZoneInfo(tz_name) if tz_name else timezone.utc
    except Exception:
        tz = timezone.utc
    start = datetime.combine(date.fromisoformat(date_from), time.min, tzinfo=tz)
    end = datetime.combine(date.fromisoformat(date_to) + timedelta(days=1), time.min, tzinfo=tz)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def _parse_ts(ts) -> datetime:
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class InMemoryStore:
    """Sirf test/local ke liye. Restart par sab ud jaata hai."""

    def __init__(self):
        self._lock = threading.Lock()
        self.tenants: dict[str, dict] = {}
        self.keys: list[dict] = []
        self.conns: list[dict] = []
        self.audit: list[dict] = []
        self.clients: list[dict] = []
        self.client_accounts: list[dict] = []
        self.sites: list[dict] = []
        self.events: list[dict] = []

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

    # --- clients / tracking (reads for ads_performance; create_*/add_* sirf test/local helpers) ---
    def create_client(self, tenant_id: str, name: str, currency: str, timezone: str = "UTC",
                      roas_source: str = "tracking") -> dict:
        c = {"id": str(uuid.uuid4()), "tenant_id": tenant_id, "name": name, "currency": currency,
             "timezone": timezone, "roas_source": roas_source}
        self.clients.append(c)
        return dict(c)

    def add_client_account(self, client_id: str, platform: str, external_id: str) -> None:
        self.client_accounts.append({"client_id": client_id, "platform": platform, "external_id": external_id})

    def add_event(self, client_id: str, session_id: str, name: str, ad_id=None, adset_id=None,
                  campaign_id=None, value=None, ts=None) -> None:
        self.events.append({"client_id": client_id, "session_id": session_id, "name": name, "ad_id": ad_id,
                            "adset_id": adset_id, "campaign_id": campaign_id, "value": value,
                            "ts": ts or datetime.now(timezone.utc).isoformat()})

    def get_client(self, tenant_id: str, client_id: str) -> dict | None:
        # Ownership check: tenant_id filter ke bina koi row nahi milti.
        for c in self.clients:
            if c["id"] == client_id and c["tenant_id"] == tenant_id:
                return dict(c)
        return None

    def list_client_accounts(self, client_id: str) -> list[str]:
        return [a["external_id"] for a in self.client_accounts
                if a["client_id"] == client_id and a["platform"] == "meta"]

    def events_summary(self, client_id: str, date_from: str, date_to: str, level: str) -> dict:
        client = next((c for c in self.clients if c["id"] == client_id), None)
        start, end = date_bounds(date_from, date_to, client["timezone"] if client else None)
        evs = [{k: e.get(k) for k in ("session_id", "name", "campaign_id", "adset_id", "ad_id", "value")}
               for e in self.events if e["client_id"] == client_id and e.get("name") != "page_leave"
               and start <= _parse_ts(e["ts"]) < end]
        conv = sorted({x for s in self.sites if s["client_id"] == client_id for x in s["conversion_events"]})
        return {"level": level, "events": evs, "conversion_events": conv or list(DEFAULT_CONVERSION_EVENTS)}

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

    @db_call(retry=True)
    def get_client(self, tenant_id: str, client_id: str) -> dict | None:
        rows = (self.db.table("clients").select("id, tenant_id, name, currency, timezone, roas_source")
                .eq("id", client_id).eq("tenant_id", tenant_id).limit(1).execute().data)
        return rows[0] if rows else None

    @db_call(retry=True)
    def list_client_accounts(self, client_id: str) -> list[str]:
        rows = (self.db.table("client_accounts").select("external_id")
                .eq("client_id", client_id).eq("platform", "meta").execute().data)
        return [r["external_id"] for r in rows]

    @db_call(retry=True)
    def events_summary(self, client_id: str, date_from: str, date_to: str, level: str) -> dict:
        crow = self.db.table("clients").select("timezone").eq("id", client_id).limit(1).execute().data
        start, end = date_bounds(date_from, date_to, crow[0]["timezone"] if crow else None)
        evs, offset, page = [], 0, 1000
        while True:             # PostgREST ek baar mein max 1000 rows deta hai
            chunk = (self.db.table("events").select(EVENT_FIELDS).eq("client_id", client_id)
                     .neq("name", "page_leave").gte("ts", start.isoformat()).lt("ts", end.isoformat()).order("id")
                     .range(offset, offset + page - 1).execute().data)
            evs.extend({k: e.get(k) for k in ("session_id", "name", "campaign_id", "adset_id", "ad_id", "value")}
                       for e in chunk)
            if len(chunk) < page or offset >= 200_000:
                break
            offset += page
        sites = self.db.table("sites").select("conversion_events").eq("client_id", client_id).execute().data
        conv = sorted({x for s in sites for x in (s.get("conversion_events") or [])})
        return {"level": level, "events": evs, "conversion_events": conv or list(DEFAULT_CONVERSION_EVENTS)}

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
