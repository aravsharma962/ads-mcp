import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import { getOwnedClient } from "@/lib/api";
import AssistantChat from "@/components/AssistantChat";

export default async function AssistantPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const client = await getOwnedClient(db, ctx.tenantId, clientId);
  if (!client) notFound();
  return <AssistantChat clientId={client.id} />;
}
