import { z } from "zod";
import { apiContext, getOwnedClient, json, notFound, readJson, UUID_RE } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/service";

type Ctx = { params: Promise<{ clientId: string }> };

/** A conversation is visible only to its creator, inside its own tenant and client. */
export async function GET(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const id = new URL(request.url).searchParams.get("id");
  const scope = { tenant_id: a.ctx.tenantId, client_id: client.id, user_id: a.ctx.userId };

  if (id === null) {
    const { data } = await a.db.from("conversations").select("id, title, created_at")
      .eq("tenant_id", scope.tenant_id).eq("client_id", scope.client_id).eq("user_id", scope.user_id)
      .order("created_at", { ascending: false }).limit(50);
    return json({ conversations: data ?? [] });
  }
  if (!UUID_RE.test(id)) return notFound();
  const { data: conv } = await a.db.from("conversations").select("id, title, created_at")
    .eq("id", id).eq("tenant_id", scope.tenant_id).eq("client_id", scope.client_id).eq("user_id", scope.user_id).maybeSingle();
  if (!conv) return notFound();
  const { data: messages } = await a.db.from("messages").select("id, role, content, created_at")
    .eq("conversation_id", id).order("id", { ascending: true }).limit(200);
  return json({ conversation: conv, messages: messages ?? [] });
}

const Create = z.object({ title: z.string().trim().max(120).optional() });

export async function POST(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const parsed = Create.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) return json({ error: "Invalid title." }, 400);
  const { data, error } = await createServiceClient().from("conversations")
    .insert({ tenant_id: a.ctx.tenantId, client_id: client.id, user_id: a.ctx.userId, title: parsed.data.title || "New conversation", created_at: new Date().toISOString() })
    .select("id, title, created_at").single();
  if (error || !data) return json({ error: "Could not create the conversation." }, 500);
  return json({ conversation: data }, 201);
}
