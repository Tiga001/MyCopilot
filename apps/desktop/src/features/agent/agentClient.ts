import { invoke } from "@tauri-apps/api/core";
import {
  approveAgentActionWithInvoker,
  cancelAgentActionWithInvoker,
  listPendingAgentActionsWithInvoker,
  rejectAgentActionWithInvoker,
  sendAgentChatWithInvoker,
} from "@agent";
import type {
  AgentActionExecutionOutput,
  AgentChatMessage,
  AgentChatOutput,
  AgentRunContext,
  PendingAgentActionSnapshot,
} from "@agent";
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
  const output = await sendAgentMessageOutput(input);

  return output.content;
}

export async function sendAgentMessageOutput(input: SendAgentMessageInput): Promise<AgentChatOutput> {
  const messages: AgentChatMessage[] = input.messages
    .filter((message) => message.status !== "pending" && message.content.trim().length > 0)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  return sendAgentChatWithInvoker(invoke, {
    apiUrl: input.apiUrl,
    apiToken: input.apiToken,
    model: input.model,
    maxTokens: input.maxTokens,
    context: input.context,
    messages,
  });
}

export async function listPendingAgentActions(): Promise<PendingAgentActionSnapshot[]> {
  return listPendingAgentActionsWithInvoker(invoke);
}

export async function approveAgentAction(actionId: string): Promise<AgentActionExecutionOutput> {
  return approveAgentActionWithInvoker(invoke, actionId);
}

export async function rejectAgentAction(
  actionId: string,
  message?: string,
): Promise<AgentActionExecutionOutput> {
  return rejectAgentActionWithInvoker(invoke, actionId, message);
}

export async function cancelAgentAction(actionId: string): Promise<boolean> {
  return cancelAgentActionWithInvoker(invoke, actionId);
}
