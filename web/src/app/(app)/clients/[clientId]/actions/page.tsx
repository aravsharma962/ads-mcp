import ActionsView from "@/components/actions/ActionsView";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";

export const metadata = { title: "Actions" };

export default async function Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const ctx = await requireTenantContext(await createClient());
  return <ActionsView clientId={clientId} isOwner={ctx.role === "owner"} />;
}
