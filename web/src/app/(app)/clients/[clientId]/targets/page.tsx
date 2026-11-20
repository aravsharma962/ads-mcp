import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import { getOwnedClient } from "@/lib/api";
import { loadTargets } from "@/lib/targets";
import TargetsEditor from "@/components/TargetsEditor";
import BusinessTypeSelect from "@/components/BusinessTypeSelect";

export default async function TargetsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const client = await getOwnedClient(db, ctx.tenantId, clientId);
  if (!client) notFound();
  return (
    <div className="space-y-6">
      <BusinessTypeSelect clientId={client.id} value={client.business_type} canEdit={ctx.role === "owner"} />
      <TargetsEditor key={client.business_type} clientId={client.id} businessType={client.business_type} initial={await loadTargets(db, client.id, client.business_type)} />
    </div>
  );
}
