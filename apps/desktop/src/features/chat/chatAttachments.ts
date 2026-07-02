import { invoke } from "@tauri-apps/api/core";
import type { AgentInputAttachment } from "@agent";

export type ComposerAttachmentKind = "file" | "image";

export interface ComposerAttachment {
  id: string;
  kind: ComposerAttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  previewUrl?: string;
  agentAttachment: AgentInputAttachment;
}

export function createAttachmentSummary(attachments: ComposerAttachment[]) {
  if (attachments.length === 0) return "";
  return `附件：${attachments.map((attachment) => attachment.name).join("、")}`;
}

export async function selectComposerAttachments(
  kind: ComposerAttachmentKind,
): Promise<ComposerAttachment[]> {
  const attachments = await invoke<AgentInputAttachment[]>("select_agent_input_attachments", {
    kind,
  });

  return attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: previewUrlForAttachment(attachment),
    agentAttachment: attachment,
  }));
}

export function buildAgentInputAttachments(attachments: ComposerAttachment[]): AgentInputAttachment[] {
  return attachments.map((attachment) => attachment.agentAttachment);
}

function previewUrlForAttachment(attachment: AgentInputAttachment) {
  if (attachment.kind !== "image") return undefined;
  if (attachment.encoding !== "base64") return undefined;
  if (!attachment.mimeType?.startsWith("image/")) return undefined;
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}
