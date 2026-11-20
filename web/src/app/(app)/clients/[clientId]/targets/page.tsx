import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import { getOwnedClient } from "@/lib/api";
import { loadTargets } from "@/lib/targets";
import TargetsEditor from "@/components/TargetsEditor";

export default async function TargetsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const client = await getOwnedClient(db, ctx.tenantId, clientId);
  if (!client) notFound();
  return <TargetsEditor clientId={client.id} initial={await loadTargets(db, client.id)} />;
}
