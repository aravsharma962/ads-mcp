export type ToolCall = { id: string; name: string; arguments: unknown };

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

export type CompletionInput = { system: string; messages: ChatMessage[]; tools: ToolDef[] };
export type CompletionResult = { text: string; toolCalls: ToolCall[]; tokensIn: number; tokensOut: number };

export interface AiProvider {
  readonly name: string;
  complete(input: CompletionInput): Promise<CompletionResult>;
}
