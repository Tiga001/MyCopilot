import type { AgentChatInput, AgentChatOutput } from "./protocol";

export interface AgentCommandInvoker {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export async function sendAgentChatWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  input: AgentChatInput,
): Promise<AgentChatOutput> {
  return invokeAgentCommand<AgentChatOutput>("agent_send_chat", { input });
}
