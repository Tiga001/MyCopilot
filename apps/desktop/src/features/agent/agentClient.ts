import { invoke } from "@tauri-apps/api/core";
import { sendAgentChatWithInvoker } from "@agent";
import type { AgentChatMessage, AgentRunContext } from "@agent";
import type { ChatMessage } from "../chat/chatTypes";

interface SendAgentMessageInput {
  apiUrl: string;
  apiToken: string;
  model: string;
  maxTokens?: number;
  context?: AgentRunContext;
  messages: ChatMessage[];
}

export async function sendAgentMessage(input: SendAgentMessageInput): Promise<string> {
  const messages: AgentChatMessage[] = input.messages
    .filter((message) => message.status !== "pending" && message.content.trim().length > 0)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const output = await sendAgentChatWithInvoker(invoke, {
    apiUrl: input.apiUrl,
    apiToken: input.apiToken,
    model: input.model,
    maxTokens: input.maxTokens,
    context: input.context,
    messages,
  });

  return output.content;
}
