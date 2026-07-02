import { invoke } from "@tauri-apps/api/core";
import type { AgentInputAttachment } from "@agent";
import type { ModelConfig, SearchMode } from "../../config/modelConfig";
import type { AppProject } from "../../config/projectConfig";
import type { ChatComposerDraft, ChatConversation, ChatMessage } from "../chat/chatTypes";

interface PersistedModelConfig {
  id: string;
  displayName: string;
  shortName: string | null;
  providerPath: string | null;
  supportsImage: boolean;
  inputPrice: string;
  outputPrice: string;
  enabled: boolean;
}

export interface ModelSettingsSnapshot {
  apiUrl: string;
  apiToken: string;
  searchMode: SearchMode;
  tavilyApiKey: string;
  models: ModelConfig[];
}

interface PersistedModelSettingsSnapshot {
  apiUrl: string;
  apiToken: string;
  searchMode: SearchMode;
  tavilyApiKey: string;
  models: PersistedModelConfig[];
}

interface PersistedProject {
  id: string;
  name: string;
  path: string | null;
  createdAt: number;
  pinnedAt: number | null;
}

interface PersistedChatMessage {
  id: string;
  role: ChatMessage["role"];
  content: string;
  createdAt: number;
  status: ChatMessage["status"] | null;
}

interface PersistedChatConversation {
  id: string;
  projectId: string | null;
  modelId: string | null;
  title: string;
  messages: PersistedChatMessage[];
  createdAt: number;
  updatedAt: number;
  pinnedAt: number | null;
  archivedAt: number | null;
}

interface PersistedComposerDraft {
  scopeId: string;
  message: string;
  permissionMode: ChatComposerDraft["permissionMode"];
  modelId: string | null;
  projectId: string | null;
  attachmentsJson: string;
  updatedAt: number;
}

export type SidebarConversationSort = "created" | "updated";
export type SidebarProjectSort = "created" | "recent";
export type SidebarSectionOrder = "projects_first" | "conversations_first";

export interface UiPreferencesSnapshot {
  sidebarConversationSort: SidebarConversationSort;
  sidebarProjectSort: SidebarProjectSort;
  sidebarSectionOrder: SidebarSectionOrder;
  updatedAt: number;
}

export interface AppDataSnapshot {
  modelSettings: ModelSettingsSnapshot | null;
  projects: AppProject[];
  conversations: ChatConversation[];
  composerDrafts: Record<string, ChatComposerDraft>;
  uiPreferences: UiPreferencesSnapshot;
}

export async function loadAppData(): Promise<AppDataSnapshot> {
  const snapshot = await invoke<{
    modelSettings: PersistedModelSettingsSnapshot | null;
    projects: PersistedProject[];
    conversations: PersistedChatConversation[];
    composerDrafts: PersistedComposerDraft[];
    uiPreferences: UiPreferencesSnapshot;
  }>("load_app_data");

  return {
    modelSettings: snapshot.modelSettings ? mapModelSettingsFromPersistence(snapshot.modelSettings) : null,
    projects: snapshot.projects.map(mapProjectFromPersistence),
    conversations: snapshot.conversations.map(mapConversationFromPersistence),
    composerDrafts: mapDraftsFromPersistence(snapshot.composerDrafts),
    uiPreferences: normalizeUiPreferences(snapshot.uiPreferences),
  };
}

export async function loadModelSettings(): Promise<ModelSettingsSnapshot | null> {
  const settings = await invoke<PersistedModelSettingsSnapshot | null>("load_model_settings");
  return settings ? mapModelSettingsFromPersistence(settings) : null;
}

export async function saveModelSettings(settings: ModelSettingsSnapshot): Promise<void> {
  await invoke("save_model_settings", {
    settings: {
      ...settings,
      models: settings.models.map(mapModelToPersistence),
    },
  });
}

export async function loadProjects(): Promise<AppProject[]> {
  const projects = await invoke<PersistedProject[]>("load_projects");
  return projects.map(mapProjectFromPersistence);
}

export async function selectProjectDirectory(): Promise<AppProject | null> {
  const project = await invoke<PersistedProject | null>("select_project_directory");
  return project ? mapProjectFromPersistence(project) : null;
}

export async function saveProject(project: AppProject): Promise<AppProject> {
  const savedProject = await invoke<PersistedProject>("save_project", {
    project: mapProjectToPersistence(project),
  });
  return mapProjectFromPersistence(savedProject);
}

export async function deleteStoredProject(projectId: string): Promise<void> {
  await invoke("delete_project", { projectId });
}

export async function showStoredProjectInFolder(projectId: string): Promise<void> {
  await invoke("show_project_in_folder", { projectId });
}

export async function loadConversations(): Promise<ChatConversation[]> {
  const conversations = await invoke<PersistedChatConversation[]>("load_conversations");
  return conversations.map(mapConversationFromPersistence);
}

export async function saveConversation(conversation: ChatConversation): Promise<ChatConversation> {
  const savedConversation = await invoke<PersistedChatConversation>("save_conversation", {
    conversation: mapConversationToPersistence(conversation),
  });
  return mapConversationFromPersistence(savedConversation);
}

export async function deleteStoredConversation(conversationId: string): Promise<void> {
  await invoke("delete_conversation", { conversationId });
}

export async function loadComposerDrafts(): Promise<Record<string, ChatComposerDraft>> {
  const drafts = await invoke<PersistedComposerDraft[]>("load_composer_drafts");
  return mapDraftsFromPersistence(drafts);
}

export async function saveComposerDraft(scopeId: string, draft: ChatComposerDraft): Promise<ChatComposerDraft> {
  const savedDraft = await invoke<PersistedComposerDraft>("save_composer_draft", {
    draft: mapDraftToPersistence(scopeId, draft),
  });
  return mapDraftFromPersistence(savedDraft);
}

export async function deleteStoredComposerDraft(scopeId: string): Promise<void> {
  await invoke("delete_composer_draft", { scopeId });
}

export async function loadUiPreferences(): Promise<UiPreferencesSnapshot> {
  const preferences = await invoke<UiPreferencesSnapshot>("load_ui_preferences");
  return normalizeUiPreferences(preferences);
}

export async function saveUiPreferences(preferences: UiPreferencesSnapshot): Promise<UiPreferencesSnapshot> {
  const savedPreferences = await invoke<UiPreferencesSnapshot>("save_ui_preferences", {
    preferences: normalizeUiPreferences(preferences),
  });
  return normalizeUiPreferences(savedPreferences);
}

function mapModelSettingsFromPersistence(settings: PersistedModelSettingsSnapshot): ModelSettingsSnapshot {
  return {
    ...settings,
    models: settings.models.map(mapModelFromPersistence),
  };
}

function mapModelFromPersistence(model: PersistedModelConfig): ModelConfig {
  return {
    ...model,
    providerPath: model.providerPath ?? undefined,
    shortName: model.shortName ?? undefined,
  };
}

function mapModelToPersistence(model: ModelConfig): PersistedModelConfig {
  return {
    ...model,
    providerPath: model.providerPath ?? null,
    shortName: model.shortName ?? null,
  };
}

function mapProjectFromPersistence(project: PersistedProject): AppProject {
  return {
    ...project,
    path: project.path ?? undefined,
    pinnedAt: project.pinnedAt ?? null,
  };
}

function mapProjectToPersistence(project: AppProject): PersistedProject {
  return {
    ...project,
    path: project.path ?? null,
    pinnedAt: project.pinnedAt ?? null,
  };
}

function mapConversationFromPersistence(conversation: PersistedChatConversation): ChatConversation {
  return {
    ...conversation,
    archivedAt: conversation.archivedAt ?? null,
    pinnedAt: conversation.pinnedAt ?? null,
    messages: conversation.messages.map(mapMessageFromPersistence),
  };
}

function mapConversationToPersistence(conversation: ChatConversation): PersistedChatConversation {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    modelId: conversation.modelId,
    title: conversation.title,
    messages: conversation.messages.map(mapMessageToPersistence),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    pinnedAt: conversation.pinnedAt ?? null,
    archivedAt: conversation.archivedAt ?? null,
  };
}

function mapMessageFromPersistence(message: PersistedChatMessage): ChatMessage {
  return {
    ...message,
    status: message.status ?? undefined,
  };
}

function mapMessageToPersistence(message: ChatMessage): PersistedChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status ?? null,
  };
}

function mapDraftsFromPersistence(drafts: PersistedComposerDraft[]): Record<string, ChatComposerDraft> {
  return drafts.reduce<Record<string, ChatComposerDraft>>((accumulator, draft) => {
    accumulator[draft.scopeId] = mapDraftFromPersistence(draft);
    return accumulator;
  }, {});
}

function mapDraftFromPersistence(draft: PersistedComposerDraft): ChatComposerDraft {
  return {
    message: draft.message,
    permissionMode: draft.permissionMode === "default" ? "default" : "full",
    modelId: draft.modelId ?? "",
    projectId: draft.projectId,
    attachments: parseDraftAttachments(draft.attachmentsJson),
    updatedAt: draft.updatedAt,
  };
}

function mapDraftToPersistence(scopeId: string, draft: ChatComposerDraft): PersistedComposerDraft {
  return {
    scopeId,
    message: draft.message,
    permissionMode: draft.permissionMode,
    modelId: draft.modelId || null,
    projectId: draft.projectId,
    attachmentsJson: JSON.stringify(draft.attachments),
    updatedAt: draft.updatedAt,
  };
}

function parseDraftAttachments(value: string): AgentInputAttachment[] {
  try {
    const parsed = JSON.parse(value) as AgentInputAttachment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function defaultUiPreferences(): UiPreferencesSnapshot {
  return {
    sidebarConversationSort: "updated",
    sidebarProjectSort: "created",
    sidebarSectionOrder: "projects_first",
    updatedAt: 0,
  };
}

function normalizeUiPreferences(preferences: UiPreferencesSnapshot | null | undefined): UiPreferencesSnapshot {
  const defaults = defaultUiPreferences();
  if (!preferences) return defaults;

  return {
    sidebarConversationSort: preferences.sidebarConversationSort === "created" ? "created" : "updated",
    sidebarProjectSort: preferences.sidebarProjectSort === "recent" ? "recent" : "created",
    sidebarSectionOrder:
      preferences.sidebarSectionOrder === "conversations_first" ? "conversations_first" : "projects_first",
    updatedAt: preferences.updatedAt ?? 0,
  };
}
