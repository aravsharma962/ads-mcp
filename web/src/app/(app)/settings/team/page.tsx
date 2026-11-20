import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireTenantContext } from "@/lib/tenant";
import InviteForm from "@/components/InviteForm";

export default async function TeamPage() {
  const db = await createClient();
  const ctx = await requireTenantContext(db);
  if (ctx.role !== "owner") notFound();
  // RLS only lets a session see its own membership row, so the roster is read with the service role,
  // strictly filtered by the tenant id from the verified session (owner role confirmed above).
  const svc = createServiceClient();
  const { data } = await svc.from("memberships").select("user_id, role").eq("tenant_id", ctx.tenantId);
  const members = await Promise.all(
    ((data ?? []) as { user_id: string; role: string }[]).map(async (m) => {
      const { data: u } = await svc.auth.admin.getUserById(m.user_id);
      return { id: m.user_id, role: m.role, email: u?.user?.email ?? "(unknown)" };
    }),
  );
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      <ul className="divide-y rounded bg-white shadow">
        {members.map((m) => (
          <li key={m.id} className="flex justify-between px-4 py-3 text-sm"><span>{m.email}</span><span className="text-gray-500">{m.role}</span></li>
        ))}
      </ul>
      <InviteForm />
    </div>
  );
}
