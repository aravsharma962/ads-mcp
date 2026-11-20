import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import { getOwnedClient } from "@/lib/api";
import { loadTargets } from "@/lib/targets";
import Dashboard from "@/components/Dashboard";

export default async function DashboardPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const client = await getOwnedClient(db, ctx.tenantId, clientId);
  if (!client) notFound();
  return <Dashboard clientId={client.id} businessType={client.business_type} targets={await loadTargets(db, client.id, client.business_type)} />;
}
