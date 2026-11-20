import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider, ChatMessage, CompletionInput, CompletionResult } from "./provider";

function toAnthropic(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: (c.arguments ?? {}) as Record<string, unknown> });
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no text)" }] });
    } else {
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

export class ClaudeProvider implements AiProvider {
  readonly name = "claude";
  async complete(input: CompletionInput): Promise<CompletionResult> {
    const model = process.env.AI_MODEL_CLAUDE;
    if (!model || !process.env.ANTHROPIC_API_KEY) throw new Error("Claude is not configured.");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 1 });
    const res = await client.messages.create({
      model,
      max_tokens: 2048,
      system: input.system,
      messages: toAnthropic(input.messages),
      tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
    });
    let text = "";
    const toolCalls = [];
    for (const b of res.content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, arguments: b.input });
    }
    return { text, toolCalls, tokensIn: res.usage?.input_tokens ?? 0, tokensOut: res.usage?.output_tokens ?? 0 };
  }
}
