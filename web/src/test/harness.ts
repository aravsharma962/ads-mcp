import { FakeDb } from "./fakeDb";

export const TA = "11111111-1111-4111-8111-111111111111";
export const TB = "22222222-2222-4222-8222-222222222222";
export const UA_OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
export const UA_MEMBER = "aaaaaaaa-0000-4000-8000-000000000002";
export const UB_OWNER = "bbbbbbbb-0000-4000-8000-000000000001";
export const CA = "ca000000-0000-4000-8000-000000000001";
export const CB = "cb000000-0000-4000-8000-000000000001";

export function seedDb() {
  return new FakeDb({
    memberships: [
      { user_id: UA_OWNER, tenant_id: TA, role: "owner" },
      { user_id: UA_MEMBER, tenant_id: TA, role: "member" },
      { user_id: UB_OWNER, tenant_id: TB, role: "owner" },
    ],
    clients: [
      { id: CA, tenant_id: TA, name: "Client A", currency: "INR", timezone: "Asia/Kolkata", roas_source: "tracking" },
      { id: CB, tenant_id: TB, name: "Client B", currency: "INR", timezone: "Asia/Kolkata", roas_source: "tracking" },
    ],
    client_accounts: [
      { client_id: CA, platform: "meta", external_id: "act_111" },
      { client_id: CB, platform: "meta", external_id: "act_999777" },
    ],
    targets: [
      { client_id: CA, metric: "ctr", min_value: 3, max_value: null },
      { client_id: CB, metric: "ctr", min_value: 7, max_value: null },
    ],
  });
}

export function req(url: string, init: { method?: string; body?: unknown } = {}) {
  return new Request("http://localhost" + url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** Session client as migration 003 leaves it: direct INSERT on these tables is denied for authenticated users. */
export function hardenedSession(db: FakeDb, userId: string | null) {
  const s = db.session(userId);
  const denied = new Set(["client_accounts", "sites", "messages"]);
  return {
    ...s,
    from: (t: string) => {
      const q: any = s.from(t);
      if (denied.has(t)) {
        const deny: any = new Proxy({}, {
          get: (_x, k) => (k === "then" ? (res: any) => Promise.resolve({ data: null, error: { message: "permission denied" } }).then(res) : () => deny),
        });
        q.insert = () => deny;
      }
      return q;
    },
  };
}
