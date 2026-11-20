import { z } from "zod";
import { apiContext, json, readJson } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/service";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const PER_PAGE = 100;
const MAX_PAGES = 50;

async function findUserIdByEmail(svc: ReturnType<typeof createServiceClient>, email: string): Promise<string | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error("lookup failed");
    const users = data?.users ?? [];
    const hit = users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < PER_PAGE) return null;
  }
  return null;
}

export async function POST(request: Request) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can invite teammates." }, 403);
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Enter a valid email address." }, 400);
  const { email } = parsed.data;
  const svc = createServiceClient();

  try {
    // Same neutral answer for every existing account (member here, member elsewhere, or no membership):
    // it does not reveal who has an account, and a pre-existing account is never attached to this agency.
    if (await findUserIdByEmail(svc, email)) return json({ error: "This email cannot be invited." }, 409);
    const redirectTo = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, "")}/login` : undefined;
    const { data, error } = await svc.auth.admin.inviteUserByEmail(email, redirectTo ? { redirectTo } : undefined);
    if (error || !data?.user) return json({ error: "Could not send the invitation. Try again later." }, 502);
    const userId = data.user.id;
    // Tenant and role are fixed server-side: the caller's tenant, role "member".
    const { error: insErr } = await svc.from("memberships").insert({ user_id: userId, tenant_id: a.ctx.tenantId, role: "member", created_at: new Date().toISOString() });
    if (insErr) return json({ error: "Could not add the teammate." }, 500);
    return json({ ok: true, email }, 201);
  } catch {
    return json({ error: "Could not process the invitation. Try again later." }, 502);
  }
}
