import type {
  AgentChatOutput,
  AgentConversationTurnInput,
  AgentConversationTurnOutput,
  AgentProposedAction,
  AgentUsageClearInput,
  AgentUsageClearOutput,
  AgentUsageSummaryInput,
  AgentUsageSummaryOutput,
} from "./protocol";

export const AGENT_EVENT_NAME = "agent_event";

export interface AgentCommandInvoker {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export type AgentActionExecutionStatus = "applied" | "failed" | "rejected";

export interface AgentGitDiffSnapshot {
  patch: string;
  truncated: boolean;
}

export interface AgentPatchExecutionResult {
  filePath: string;
  appliedFilePaths: string[];
  gitDiff?: AgentGitDiffSnapshot;
  gitDiffError?: string;
  error?: string;
}

export interface AgentCommandExecutionResult {
  command: string;
  cwd: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export interface AgentActionExecutionOutput {
  actionId: string;
  actionType: string;
  toolName: string;
  status: AgentActionExecutionStatus;
  patchResult?: AgentPatchExecutionResult;
  commandResult?: AgentCommandExecutionResult;
  agentOutput: AgentChatOutput;
}

export interface PendingAgentActionSnapshot {
  actionId: string;
  actionType: string;
  toolName: string;
  runId: string;
  conversationId?: string;
  assistantMessageId?: string;
  action: AgentProposedAction;
  createdAt: number;
}

export async function startAgentConversationTurnWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  input: AgentConversationTurnInput,
): Promise<AgentConversationTurnOutput> {
  return invokeAgentCommand<AgentConversationTurnOutput>("agent_start_conversation_turn", { input });
}

export async function listPendingAgentActionsWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
): Promise<PendingAgentActionSnapshot[]> {
  return invokeAgentCommand<PendingAgentActionSnapshot[]>("agent_list_pending_actions");
}

export async function approveAgentActionWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  actionId: string,
): Promise<AgentActionExecutionOutput> {
  return invokeAgentCommand<AgentActionExecutionOutput>("agent_approve_action", { actionId });
}

export async function rejectAgentActionWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  actionId: string,
  message?: string,
): Promise<AgentActionExecutionOutput> {
  return invokeAgentCommand<AgentActionExecutionOutput>("agent_reject_action", { actionId, message });
}

export async function cancelAgentActionWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  actionId: string,
): Promise<boolean> {
  return invokeAgentCommand<boolean>("agent_cancel_action", { actionId });
}

export async function cancelAgentRunWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  runId: string,
): Promise<boolean> {
  return invokeAgentCommand<boolean>("agent_cancel_run", { runId });
}

export async function getAgentUsageSummaryWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  input: AgentUsageSummaryInput,
): Promise<AgentUsageSummaryOutput> {
  return invokeAgentCommand<AgentUsageSummaryOutput>("agent_get_usage_summary", { input });
}

export async function clearAgentUsageRecordsWithInvoker(
  invokeAgentCommand: AgentCommandInvoker,
  input: AgentUsageClearInput = {},
): Promise<AgentUsageClearOutput> {
  return invokeAgentCommand<AgentUsageClearOutput>("agent_clear_usage_records", { input });
}
