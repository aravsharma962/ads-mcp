import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import { getOwnedClient } from "@/lib/api";
import AccountsManager from "@/components/AccountsManager";

export default async function AccountsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const client = await getOwnedClient(db, ctx.tenantId, clientId);
  if (!client) notFound();
  const { data } = await db.from("client_accounts").select("external_id").eq("client_id", client.id);
  const ids = ((data ?? []) as { external_id: string }[]).map((r) => r.external_id);
  return <AccountsManager clientId={client.id} currency={client.currency} initial={ids} canEdit={ctx.role === "owner"} />;
}
