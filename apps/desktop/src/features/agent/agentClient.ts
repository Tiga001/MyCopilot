import { invoke } from "@tauri-apps/api/core";
import {
  approveAgentActionWithInvoker,
  cancelAgentActionWithInvoker,
  listPendingAgentActionsWithInvoker,
  rejectAgentActionWithInvoker,
  startAgentConversationTurnWithInvoker,
} from "@agent";
import type {
  AgentActionExecutionOutput,
  AgentConversationTurnInput,
  AgentConversationTurnOutput,
  PendingAgentActionSnapshot,
} from "@agent";

export type StartConversationTurnInput = AgentConversationTurnInput;
export type StartConversationTurnOutput = AgentConversationTurnOutput;

export async function startConversationTurn(
  input: StartConversationTurnInput,
): Promise<StartConversationTurnOutput> {
  return startAgentConversationTurnWithInvoker(invoke, input);
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
