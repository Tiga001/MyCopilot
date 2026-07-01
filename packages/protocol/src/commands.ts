export type AgentCommand =
  | { type: "select_workspace"; path: string }
  | { type: "send_message"; content: string }
  | { type: "approve_patch"; patchId: string }
  | { type: "approve_command"; commandId: string }
  | { type: "cancel_task"; taskId: string };
