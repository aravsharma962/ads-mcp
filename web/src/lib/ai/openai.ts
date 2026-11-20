import "server-only";
import OpenAI from "openai";
import type { AiProvider, ChatMessage, CompletionInput, CompletionResult } from "./provider";

function toOpenAI(system: string, messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) }
          : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  async complete(input: CompletionInput): Promise<CompletionResult> {
    const model = process.env.AI_MODEL_OPENAI;
    if (!model || !process.env.OPENAI_API_KEY) throw new Error("OpenAI is not configured.");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45_000, maxRetries: 1 });
    const res = await client.chat.completions.create({
      model,
      messages: toOpenAI(input.system, input.messages),
      tools: input.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    });
    const msg = res.choices[0]?.message;
    const toolCalls = (msg?.tool_calls ?? []).flatMap((c) => {
      if (c.type !== "function") return [];
      let args: unknown = {};
      try { args = JSON.parse(c.function.arguments || "{}"); } catch { args = {}; }
      return [{ id: c.id, name: c.function.name, arguments: args }];
    });
    return { text: msg?.content ?? "", toolCalls, tokensIn: res.usage?.prompt_tokens ?? 0, tokensOut: res.usage?.completion_tokens ?? 0 };
  }
}
