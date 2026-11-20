import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import { getOwnedClient } from "@/lib/api";
import { trackingHealth } from "@/lib/tracking";
import TrackingSetup from "@/components/TrackingSetup";

export const dynamic = "force-dynamic";

export default async function TrackingPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const client = await getOwnedClient(db, ctx.tenantId, clientId);
  if (!client) notFound();
  const { data: site } = await db.from("sites").select("site_key, allowed_origins").eq("client_id", client.id).maybeSingle();
  const health = site ? await trackingHealth(db, client.id) : null;
  const appUrl = process.env.APP_URL ?? "";
  return <TrackingSetup clientId={client.id} appUrl={appUrl} initialSite={site} initialHealth={health} canEdit={ctx.role === "owner"} businessType={client.business_type} />;
}
