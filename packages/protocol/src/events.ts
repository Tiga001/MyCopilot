export type AgentEvent =
  | { type: "message"; content: string }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "diff"; filePath: string; patch: string }
  | { type: "command_output"; command: string; output: string }
  | { type: "task_done"; success: boolean };
