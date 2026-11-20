import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiContext, getOwnedClient, json, notFound, readJson } from "@/lib/api";
import { normAccount } from "@/lib/accounts";
import { createServiceClient } from "@/lib/supabase/service";
import { HubError, addAccount, callTool, listAccounts, removeAccount } from "@/lib/hub";

type Ctx = { params: Promise<{ clientId: string }> };

const AccountBody = z.object({
  account: z.string().trim().min(1).max(64).transform((v, ctx) => {
    const n = normAccount(v);
    if (!n) { ctx.addIssue({ code: "custom", message: "invalid account" }); return z.NEVER; }
    return n;
  }),
  token: z.string().trim().min(1).max(4000),
});

/** Is this account linked to any client of the tenant (other than the given one)? */
async function usedElsewhere(db: SupabaseClient, tenantId: string, clientId: string, externalId: string) {
  const { data: mine } = await db.from("clients").select("id").eq("tenant_id", tenantId);
  const ids = ((mine ?? []) as { id: string }[]).map((c) => c.id).filter((id) => id !== clientId);
  if (ids.length === 0) return false;
  const { data } = await db.from("client_accounts").select("client_id").in("client_id", ids).eq("external_id", externalId);
  return ((data ?? []) as unknown[]).length > 0;
}

export async function GET(_req: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const { data } = await a.db.from("client_accounts").select("platform, external_id").eq("client_id", client.id);
  const accounts = ((data ?? []) as { platform: string; external_id: string }[]).map((r) => ({ platform: r.platform, external_id: r.external_id }));
  return json({ accounts, currency: client.currency, timezone: client.timezone });
}

export async function POST(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can connect ad accounts." }, 403);
  const parsed = AccountBody.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Enter a valid ad account id and an access token." }, 400);
  const { account, token } = parsed.data;

  const { data: existing } = await a.db
    .from("client_accounts").select("external_id").eq("client_id", client.id).eq("external_id", account).maybeSingle();
  if (existing) return json({ error: "This ad account is already connected to this client." }, 409);

  // Does the tenant already have a hub connection for this account (made by another client or by an admin)?
  let preExisting: boolean;
  try {
    preExisting = (await listAccounts(a.ctx.tenantId)).some((c) => c.external_id === account);
  } catch {
    return json({ error: "The data service is unavailable. Try again later." }, 502);
  }

  // Only a connection created by THIS request may ever be removed by its rollback.
  const rollback = async () => {
    if (preExisting) return;
    if (!(await usedElsewhere(a.db, a.ctx.tenantId, client.id, account))) {
      try { await removeAccount(a.ctx.tenantId, account); } catch { /* best effort */ }
    }
  };

  let externalId = account;
  if (!preExisting) {
    // An existing connection keeps its stored token: the supplied one is never allowed to replace it unverified.
    try {
      const added = await addAccount(a.ctx.tenantId, account, token);
      externalId = normAccount(added?.external_id ?? "") || account;
    } catch (e) {
      if (e instanceof HubError && e.status >= 400 && e.status < 500) return json({ error: `Could not connect the account: ${e.message}` }, 400);
      return json({ error: "The data service is unavailable. Try again later." }, 502);
    }
  }

  // Verify the token works and the account currency matches the client's currency.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const res = await callTool(a.ctx.tenantId, "meta_ads_insights", {
      external_id: externalId, date_from: iso(yesterday), date_to: iso(today), level: "campaign",
    });
    const cur = typeof res?.currency === "string" && res.currency ? res.currency.toUpperCase() : null;
    if (!cur) {
      await rollback();
      return json({ error: "Could not verify the ad account currency. Try again later." }, 400);
    }
    if (cur !== client.currency.toUpperCase()) {
      await rollback();
      return json({
        error: `Currency mismatch: this ad account uses ${cur} but the client uses ${client.currency}. All accounts of one client must share the same currency.`,
      }, 400);
    }
  } catch (e) {
    await rollback();
    const msg = e instanceof HubError ? e.message : "unknown error";
    return json({ error: `Could not verify the ad account: ${msg}` }, 400);
  }

  // Direct INSERT is revoked for browser sessions (migration 003); the owner check and hub verification above gate this write.
  const { error } = await createServiceClient().from("client_accounts").insert({ client_id: client.id, platform: "meta", external_id: externalId });
  if (error) {
    await rollback();
    return json({ error: "Could not save the ad account." }, 500);
  }
  return json({ account: { platform: "meta", external_id: externalId } }, 201);
}

export async function DELETE(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can remove ad accounts." }, 403);
  const externalId = normAccount(new URL(request.url).searchParams.get("external_id") ?? "");
  if (!externalId) return notFound();
  const { data: row } = await a.db
    .from("client_accounts").select("external_id").eq("client_id", client.id).eq("external_id", externalId).maybeSingle();
  if (!row) return notFound();
  await a.db.from("client_accounts").delete().eq("client_id", client.id).eq("external_id", externalId);
  if (!(await usedElsewhere(a.db, a.ctx.tenantId, client.id, externalId))) {
    try { await removeAccount(a.ctx.tenantId, externalId); } catch { /* connection may already be gone */ }
  }
  return json({ ok: true });
}
