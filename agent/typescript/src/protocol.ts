export type AgentMessageRole = "system" | "user" | "assistant";

export type AgentRunStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRunMode = "chat" | "plan" | "edit";

export type AgentApiStyle = "openai_compatible" | "anthropic_compatible";

export type AgentToolName =
  | "read_file"
  | "search_files"
  | "search_code"
  | "git_diff"
  | "generate_patch"
  | "apply_patch"
  | "run_command"
  | (string & {});

export type AgentToolSafety = "read_only" | "requires_approval" | "destructive";

export type AgentApprovalStatus = "not_required" | "required" | "approved" | "rejected";

export type AgentCommandOutputStream = "stdout" | "stderr";

export interface AgentChatMessage {
  role: AgentMessageRole;
  content: string;
}

export interface AgentWorkspaceContext {
  projectId?: string;
  displayName?: string;
  rootPath?: string;
}

export interface AgentRunContext {
  conversationId?: string;
  projectId?: string | null;
  workspace?: AgentWorkspaceContext;
}

export interface AgentChatInput {
  apiUrl: string;
  apiToken: string;
  model: string;
  apiStyle?: AgentApiStyle;
  maxTokens?: number;
  temperature?: number;
  mode?: AgentRunMode;
  stream?: boolean;
  context?: AgentRunContext;
  messages: AgentChatMessage[];
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentChatOutput {
  status: Extract<AgentRunStatus, "completed">;
  content: string;
  runId: string;
  events: AgentEvent[];
  toolDefinitions: AgentToolDefinition[];
  usage?: AgentUsage;
  finishReason?: string;
  proposedActions: AgentProposedAction[];
}

export interface AgentStateSnapshot {
  status: AgentRunStatus;
  activeRunId: string | null;
  lastError: string | null;
  updatedAt: number;
}

export interface AgentToolCall {
  id: string;
  tool: AgentToolName;
  args: unknown;
  approvalStatus: AgentApprovalStatus;
  reason?: string;
}

export interface AgentToolDefinition {
  name: AgentToolName;
  description: string;
  inputSchema: unknown;
  safety: AgentToolSafety;
  requiresWorkspace: boolean;
  requiresApproval: boolean;
}

export interface AgentToolResult {
  callId: string;
  tool: AgentToolName;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentDiffProposal {
  filePath: string;
  patch: string;
  summary?: string;
  approvalStatus: AgentApprovalStatus;
}

export interface AgentCommandRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  approvalStatus: AgentApprovalStatus;
  reason?: string;
}

export type AgentProposedAction =
  | { type: "tool_call"; call: AgentToolCall }
  | { type: "diff"; diff: AgentDiffProposal }
  | { type: "command"; command: AgentCommandRequest };

export type AgentEvent =
  | { type: "state"; runId: string; state: AgentStateSnapshot }
  | { type: "message_delta"; runId: string; delta: string }
  | { type: "message"; runId: string; content: string }
  | { type: "tool_call"; runId: string; call: AgentToolCall }
  | { type: "tool_result"; runId: string; result: AgentToolResult }
  | { type: "diff"; runId: string; diff: AgentDiffProposal }
  | {
      type: "command_output";
      runId: string;
      command: string;
      stream: AgentCommandOutputStream;
      output: string;
    }
  | { type: "error"; runId?: string; message: string; recoverable: boolean }
  | { type: "done"; runId: string; success: boolean };
