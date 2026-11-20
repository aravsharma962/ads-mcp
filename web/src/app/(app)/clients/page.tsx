import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/tenant";
import NewClientForm from "@/components/NewClientForm";

export default async function ClientsPage() {
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  const { data } = await db
    .from("clients")
    .select("id, name, currency, timezone")
    .eq("tenant_id", ctx.tenantId)
    .order("created_at", { ascending: false });
  const clients = (data ?? []) as { id: string; name: string; currency: string; timezone: string }[];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Clients</h1>
      {clients.length === 0 ? (
        <p className="text-gray-600">No clients yet.{ctx.role === "owner" ? " Create your first client below." : " Ask your agency owner to add one."}</p>
      ) : (
        <ul className="divide-y rounded bg-white shadow">
          {clients.map((c) => (
            <li key={c.id}>
              <Link href={`/clients/${c.id}`} className="flex justify-between px-4 py-3 hover:bg-gray-50">
                <span className="font-medium">{c.name}</span>
                <span className="text-sm text-gray-500">{c.currency} · {c.timezone}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {ctx.role === "owner" && <NewClientForm />}
    </div>
  );
}
