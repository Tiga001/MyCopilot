export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: "pending" | "sent" | "error";
}

export interface ChatSubmitOptions {
  modelId: string;
  projectId: string | null;
}

export interface ChatConversation {
  id: string;
  projectId: string | null;
  modelId: string | null;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
