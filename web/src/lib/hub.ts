import "server-only";

export class HubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HubError";
    this.status = status;
  }
}

export type HubTool = { name: string; description: string; input_schema: Record<string, unknown> };
export type HubAccount = { platform: string; external_id: string };

const TIMEOUT_MS = 20_000;

export function redactText(text: string, extra: string[] = []): string {
  let out = text;
  for (const s of [process.env.HUB_SERVICE_SECRET ?? "", ...extra]) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out
    .replace(/\b(EAA|sk-ant-|sk-|sk_)[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

type Init = { method?: string; body?: unknown; redact?: string[]; headers?: Record<string, string> };

/**
 * Server-to-server call to the hub internal API. The tenant id must come from the verified session.
 * Only Content-Type, X-Hub-Secret and X-Tenant-Id are ever sent; caller-supplied headers are ignored.
 */
export async function hubFetch(tenantId: string, path: string, init: Init = {}): Promise<{ status: number; body: any }> {
  const base = process.env.HUB_URL;
  const secret = process.env.HUB_SERVICE_SECRET;
  if (!base || !secret) throw new HubError(503, "The data service is not configured.");
  if (!tenantId) throw new HubError(400, "Missing tenant.");
  const headers = new Headers({ "X-Hub-Secret": secret, "X-Tenant-Id": tenantId });
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(base.replace(/\/+$/, "") + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new HubError(503, "The data service is unavailable. Try again later.");
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body && typeof body.error === "string" ? body.error : `Data service error (${res.status}).`;
    throw new HubError(res.status, redactText(msg, init.redact));
  }
  return { status: res.status, body };
}

export async function listAccounts(tenantId: string): Promise<HubAccount[]> {
  const { body } = await hubFetch(tenantId, "/internal/accounts");
  return Array.isArray(body) ? body : [];
}

export async function addAccount(tenantId: string, account: string, token: string): Promise<{ external_id: string }> {
  const { body } = await hubFetch(tenantId, "/internal/accounts", { method: "POST", body: { account, token }, redact: [token] });
  return body;
}

/** Returns false when the hub does not know the account. */
export async function removeAccount(tenantId: string, externalId: string): Promise<boolean> {
  try {
    await hubFetch(tenantId, `/internal/accounts/${encodeURIComponent(externalId)}`, { method: "DELETE" });
    return true;
  } catch (e) {
    if (e instanceof HubError && e.status === 404) return false;
    throw e;
  }
}

export async function listTools(tenantId: string): Promise<HubTool[]> {
  const { body } = await hubFetch(tenantId, "/internal/tools");
  return Array.isArray(body) ? body : [];
}

export async function callTool(tenantId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const { body } = await hubFetch(tenantId, "/internal/tools/call", { method: "POST", body: { name, arguments: args } });
  if (body && typeof body.error === "string") throw new HubError(200, redactText(body.error));
  const result = body?.result;
  // Tools report their own failures as {"error": "..."} inside the result (for example access denied).
  if (result && typeof result === "object" && !Array.isArray(result) && typeof result.error === "string") {
    throw new HubError(200, redactText(result.error));
  }
  return result;
}
