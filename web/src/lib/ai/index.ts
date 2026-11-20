import "server-only";
import type { AiProvider } from "./provider";
import { ClaudeProvider } from "./claude";
import { OpenAiProvider } from "./openai";

export function getProvider(): AiProvider {
  return (process.env.AI_PROVIDER ?? "claude").toLowerCase() === "openai" ? new OpenAiProvider() : new ClaudeProvider();
}
