import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import { getOwnedClient } from "@/lib/api";

export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const client = await getOwnedClient(db, ctx.tenantId, clientId);
  if (!client) notFound();
  const tabs = [
    ["Dashboard", ""],
    ["Actions", "/actions"],
    ["Report", "/report"],
    ["Site pages", "/pages"],
    ["Leads", "/leads"],
    ["Targets", "/targets"],
    ["Accounts", "/accounts"],
    ["Assistant", "/assistant"],
    ["Tracking", "/tracking"],
  ];
  return (
    <div className="space-y-4">
      <div>
        <Link href="/clients" className="text-sm text-gray-500">&larr; Clients</Link>
        <h1 className="text-2xl font-semibold">{client.name}</h1>
      </div>
      <nav className="flex flex-wrap gap-4 border-b text-sm print:hidden">
        {tabs.map(([label, path]) => (
          <Link key={label} href={`/clients/${client.id}${path}`} className="border-b-2 border-transparent px-1 pb-2 hover:border-black">
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
