import { z } from "zod";
import { apiContext, getOwnedClient, json, notFound, readJson, UUID_RE } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/service";
import { getProvider } from "@/lib/ai";
import { assertWithinCap, CapReachedError } from "@/lib/usage";
import { createLimiter } from "@/lib/ratelimit";
import { runChat, type ChatEvent } from "@/lib/ai/chat";

export const maxDuration = 60;
const CHAT_BUDGET_MS = 50_000;   // leave headroom under maxDuration so the stream ends cleanly
export const dynamic = "force-dynamic";

const limiter = createLimiter({ limit: 20, windowMs: 60_000 });   // per tenant, best effort per instance

type Ctx = { params: Promise<{ clientId: string }> };
const Body = z.object({ message: z.string().trim().min(1).max(4000), conversation_id: z.string().optional() });

export async function POST(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Enter a message of up to 4000 characters." }, 400);

  if (!limiter.hit(a.ctx.tenantId)) {
    return json({ error: "You are sending messages too quickly. Wait a minute and try again." }, 429, { "retry-after": "60" });
  }

  const svc = createServiceClient();
  // Cheap refusals first: nothing is created in the database for a request that cannot be served.
  let provider;
  try {
    provider = getProvider();
  } catch {
    return json({ error: "The AI service is not configured." }, 503);
  }
  try {
    await assertWithinCap(a.ctx.tenantId, { db: svc });
  } catch (e) {
    if (e instanceof CapReachedError) return json({ error: e.message }, 429);
    return json({ error: "Could not check AI usage. Try again later." }, 503);
  }

  let conversationId = parsed.data.conversation_id;
  if (conversationId !== undefined) {
    if (!UUID_RE.test(conversationId)) return notFound();
    const { data } = await svc.from("conversations").select("id")
      .eq("id", conversationId).eq("tenant_id", a.ctx.tenantId).eq("client_id", client.id).eq("user_id", a.ctx.userId).maybeSingle();
    if (!data) return notFound();
  } else {
    const { data, error } = await svc.from("conversations")
      .insert({ tenant_id: a.ctx.tenantId, client_id: client.id, user_id: a.ctx.userId, title: parsed.data.message.slice(0, 60), created_at: new Date().toISOString() })
      .select("id").single();
    if (error || !data) return json({ error: "Could not start the conversation." }, 500);
    conversationId = (data as { id: string }).id;
  }

  const convId = conversationId;
  const enc = new TextEncoder();
  let closed = false;   // set when the client goes away or the stream is finished
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ChatEvent | { type: "conversation"; id: string }) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { closed = true; }
      };
      const deadline = Date.now() + CHAT_BUDGET_MS;
      const it = runChat({
        tenantId: a.ctx.tenantId, clientId: client.id, userId: a.ctx.userId,
        conversationId: convId, userMessage: parsed.data.message, provider, db: svc,
      })[Symbol.asyncIterator]();
      send({ type: "conversation", id: convId });
      try {
        while (!closed) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), Math.max(0, deadline - Date.now())); });
          const next = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(timer));
          if (next === "timeout") {
            send({ type: "error", message: "This is taking too long. Please try a narrower question." });
            void it.return(undefined).catch(() => {});
            break;
          }
          if (next.done) break;
          send(next.value);
        }
      } catch {
        send({ type: "error", message: "Something went wrong. Try again later." });
      }
      try { controller.close(); } catch { /* already closed or cancelled */ }
      closed = true;
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
  });
}
