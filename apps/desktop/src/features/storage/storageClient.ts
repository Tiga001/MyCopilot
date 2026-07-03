import { invoke } from "@tauri-apps/api/core";
import type { AgentInputAttachment, AgentPromptPreferences } from "@agent";
import type { ModelConfig, SearchMode } from "../../config/modelConfig";
import type { AppProject } from "../../config/projectConfig";
import type {
  ChatAgentRunView,
  ChatComposerDraft,
  ChatConversation,
  ChatMessage,
  ChatMessageAttachment,
  ChatMessageUiState,
} from "../chat/chatTypes";

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

export interface AgentPromptPreferencesSnapshot extends AgentPromptPreferences {
  workMode: "coding" | "general";
  tone: "friendly" | "pragmatic";
  detailLevel: "low" | "medium" | "high";
  customInstructions: string;
  updatedAt: number;
}

interface PersistedAgentPromptPreferences {
  workMode: string;
  tone: string;
  detailLevel: string;
  customInstructions: string;
  updatedAt: number;
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
  attachments?: ChatMessageAttachment[] | null;
  agentRunJson: string | null;
  uiStateJson: string | null;
}

type PersistedChatMessageState = Pick<
  PersistedChatMessage,
  "id" | "content" | "status" | "agentRunJson" | "uiStateJson"
>;

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
  unreadAt: number | null;
}

type PersistedChatConversationMeta = Omit<PersistedChatConversation, "messages">;

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
export type SidebarProjectSort = "created" | "recent" | "manual";
export type SidebarSectionOrder = "projects_first" | "conversations_first";

export interface UiPreferencesSnapshot {
  profileAvatarDataUrl: string | null;
  profileDisplayName: string;
  profileHandle: string;
  sidebarConversationSort: SidebarConversationSort;
  sidebarProjectSort: SidebarProjectSort;
  sidebarProjectOrder: string[];
  sidebarSectionOrder: SidebarSectionOrder;
  nativeFontSmoothing: boolean;
  translucentSidebar: boolean;
  updatedAt: number;
}

export interface AppDataSnapshot {
  modelSettings: ModelSettingsSnapshot | null;
  projects: AppProject[];
  conversations: ChatConversation[];
  composerDrafts: Record<string, ChatComposerDraft>;
  uiPreferences: UiPreferencesSnapshot;
  agentPromptPreferences: AgentPromptPreferencesSnapshot;
}

export async function loadAppData(): Promise<AppDataSnapshot> {
  const snapshot = await invoke<{
    modelSettings: PersistedModelSettingsSnapshot | null;
    projects: PersistedProject[];
    conversations: PersistedChatConversation[];
    composerDrafts: PersistedComposerDraft[];
    uiPreferences: UiPreferencesSnapshot;
    agentPromptPreferences: PersistedAgentPromptPreferences;
  }>("load_app_data");

  return {
    modelSettings: snapshot.modelSettings ? mapModelSettingsFromPersistence(snapshot.modelSettings) : null,
    projects: snapshot.projects.map(mapProjectFromPersistence),
    conversations: snapshot.conversations.map(mapConversationFromPersistence),
    composerDrafts: mapDraftsFromPersistence(snapshot.composerDrafts),
    uiPreferences: normalizeUiPreferences(snapshot.uiPreferences),
    agentPromptPreferences: normalizeAgentPromptPreferences(snapshot.agentPromptPreferences),
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

export async function loadAgentPromptPreferences(): Promise<AgentPromptPreferencesSnapshot> {
  const preferences = await invoke<PersistedAgentPromptPreferences>("load_agent_prompt_preferences");
  return normalizeAgentPromptPreferences(preferences);
}

export async function saveAgentPromptPreferences(
  preferences: AgentPromptPreferences,
): Promise<AgentPromptPreferencesSnapshot> {
  const savedPreferences = await invoke<PersistedAgentPromptPreferences>("save_agent_prompt_preferences", {
    preferences: normalizeAgentPromptPreferences(preferences),
  });
  return normalizeAgentPromptPreferences(savedPreferences);
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

export async function saveConversationMeta(conversation: ChatConversation): Promise<void> {
  await invoke("save_conversation_meta", {
    conversation: mapConversationMetaToPersistence(conversation),
  });
}

export async function upsertChatMessages(
  conversationId: string,
  messages: ChatMessage[],
  positionOffset: number,
): Promise<void> {
  await invoke("upsert_chat_messages", {
    conversationId,
    messages: messages.map(mapMessageToPersistence),
    positionOffset,
  });
}

export async function saveChatMessageState(conversationId: string, message: ChatMessage): Promise<void> {
  await invoke("save_chat_message_state", {
    conversationId,
    message: mapMessageStateToPersistence(message),
  });
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

export async function selectProfileAvatar(): Promise<string | null> {
  return invoke<string | null>("select_profile_avatar");
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
    unreadAt: conversation.unreadAt ?? null,
    messages: conversation.messages.map(mapMessageFromPersistence),
  };
}

function mapConversationToPersistence(conversation: ChatConversation): PersistedChatConversation {
  return {
    ...mapConversationMetaToPersistence(conversation),
    messages: conversation.messages.map(mapMessageToPersistence),
  };
}

function mapConversationMetaToPersistence(conversation: ChatConversation): PersistedChatConversationMeta {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    modelId: conversation.modelId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    pinnedAt: conversation.pinnedAt ?? null,
    archivedAt: conversation.archivedAt ?? null,
    unreadAt: conversation.unreadAt ?? null,
  };
}

function mapMessageFromPersistence(message: PersistedChatMessage): ChatMessage {
  const agentRun = parseJsonField<ChatAgentRunView>(message.agentRunJson);
  const uiState = parseJsonField<ChatMessageUiState>(message.uiStateJson);
  const normalizedAgentRun = agentRun ? normalizePersistedAgentRun(agentRun) : undefined;

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: normalizePersistedMessageStatus(message.status, normalizedAgentRun),
    attachments: message.attachments?.length ? message.attachments : undefined,
    agentRun: normalizedAgentRun,
    uiState: uiState ?? undefined,
  };
}

function mapMessageToPersistence(message: ChatMessage): PersistedChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status ?? null,
    agentRunJson: stringifyJsonField(message.agentRun),
    uiStateJson: stringifyJsonField(message.uiState),
  };
}

function parseJsonField<T>(value: string | null | undefined): T | null {
  if (!value) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function stringifyJsonField(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizePersistedAgentRun(agentRun: ChatAgentRunView): ChatAgentRunView {
  const hasCompletedAt = Boolean(agentRun.completedAt);
  const isActive =
    agentRun.status === "starting" ||
    agentRun.status === "running" ||
    agentRun.status === "waiting_for_approval";

  if (!isActive || hasCompletedAt) {
    return agentRun;
  }

  const interruptedAt = agentRun.lastResponseAt ?? agentRun.firstResponseAt ?? agentRun.startedAt ?? Date.now();
  return {
    ...agentRun,
    status: "cancelled",
    completedAt: interruptedAt,
    error: agentRun.error ?? "应用关闭后，该次处理已中断。",
  };
}

function normalizePersistedMessageStatus(
  status: ChatMessage["status"] | null,
  agentRun: ChatAgentRunView | undefined,
): ChatMessage["status"] | undefined {
  if (status === "pending" && agentRun?.status === "cancelled") {
    return "sent";
  }

  return status ?? undefined;
}

function mapMessageStateToPersistence(message: ChatMessage): PersistedChatMessageState {
  return {
    id: message.id,
    content: message.content,
    status: message.status ?? null,
    agentRunJson: stringifyJsonField(message.agentRun),
    uiStateJson: stringifyJsonField(message.uiState),
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

export function defaultAgentPromptPreferences(): AgentPromptPreferencesSnapshot {
  return {
    workMode: "coding",
    tone: "pragmatic",
    detailLevel: "medium",
    customInstructions: "",
    updatedAt: 0,
  };
}

function normalizeAgentPromptPreferences(
  preferences: AgentPromptPreferences | PersistedAgentPromptPreferences | null | undefined,
): AgentPromptPreferencesSnapshot {
  const defaults = defaultAgentPromptPreferences();
  if (!preferences) return defaults;

  return {
    workMode: preferences.workMode === "general" ? "general" : defaults.workMode,
    tone: preferences.tone === "friendly" ? "friendly" : defaults.tone,
    detailLevel:
      preferences.detailLevel === "low" || preferences.detailLevel === "high"
        ? preferences.detailLevel
        : defaults.detailLevel,
    customInstructions:
      typeof preferences.customInstructions === "string" ? preferences.customInstructions.trim() : "",
    updatedAt: typeof preferences.updatedAt === "number" ? preferences.updatedAt : defaults.updatedAt,
  };
}

export function defaultUiPreferences(): UiPreferencesSnapshot {
  return {
    profileAvatarDataUrl: null,
    profileDisplayName: "",
    profileHandle: "USER",
    sidebarConversationSort: "updated",
    sidebarProjectSort: "created",
    sidebarProjectOrder: [],
    sidebarSectionOrder: "projects_first",
    nativeFontSmoothing: false,
    translucentSidebar: false,
    updatedAt: 0,
  };
}

function normalizeUiPreferences(preferences: UiPreferencesSnapshot | null | undefined): UiPreferencesSnapshot {
  const defaults = defaultUiPreferences();
  if (!preferences) return defaults;

  return {
    profileAvatarDataUrl:
      typeof preferences.profileAvatarDataUrl === "string" && preferences.profileAvatarDataUrl.startsWith("data:image/")
        ? preferences.profileAvatarDataUrl
        : defaults.profileAvatarDataUrl,
    profileDisplayName: normalizeProfileText(preferences.profileDisplayName, defaults.profileDisplayName),
    profileHandle: normalizeProfileHandle(preferences.profileHandle, defaults.profileHandle),
    sidebarConversationSort: preferences.sidebarConversationSort === "created" ? "created" : "updated",
    sidebarProjectSort:
      preferences.sidebarProjectSort === "recent" || preferences.sidebarProjectSort === "manual"
        ? preferences.sidebarProjectSort
        : "created",
    sidebarProjectOrder: normalizeStringList(preferences.sidebarProjectOrder),
    sidebarSectionOrder:
      preferences.sidebarSectionOrder === "conversations_first" ? "conversations_first" : "projects_first",
    nativeFontSmoothing: Boolean(preferences.nativeFontSmoothing),
    translucentSidebar: Boolean(preferences.translucentSidebar),
    updatedAt: preferences.updatedAt ?? 0,
  };
}

function normalizeProfileText(value: string | null | undefined, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalizedValue = value.trim();
  if (normalizedValue.toLowerCase() === "hx z") return fallback;
  return normalizedValue || fallback;
}

function normalizeProfileHandle(value: string | null | undefined, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalizedValue = value.trim().replace(/^@+/, "");
  if (normalizedValue.toLowerCase() === "hxz9393") return fallback;
  return normalizedValue || fallback;
}

function normalizeStringList(values: string[] | null | undefined) {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.filter((value) => {
    if (typeof value !== "string") return false;
    const normalizedValue = value.trim();
    if (!normalizedValue || seen.has(normalizedValue)) return false;
    seen.add(normalizedValue);
    return true;
  });
}
