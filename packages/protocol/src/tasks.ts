export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTask {
  id: string;
  status: TaskStatus;
  title: string;
  createdAt: string;
  updatedAt: string;
}
