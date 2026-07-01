import { invoke } from "@tauri-apps/api/core";
import type { ModelConfig, SearchMode } from "../../config/modelConfig";
import type { AppProject } from "../../config/projectConfig";
import type { ChatConversation, ChatMessage } from "../chat/chatTypes";

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
}

export interface AppDataSnapshot {
  modelSettings: ModelSettingsSnapshot | null;
  projects: AppProject[];
  conversations: ChatConversation[];
}

export async function loadAppData(): Promise<AppDataSnapshot> {
  const snapshot = await invoke<{
    modelSettings: PersistedModelSettingsSnapshot | null;
    projects: PersistedProject[];
    conversations: PersistedChatConversation[];
  }>("load_app_data");

  return {
    modelSettings: snapshot.modelSettings ? mapModelSettingsFromPersistence(snapshot.modelSettings) : null,
    projects: snapshot.projects.map(mapProjectFromPersistence),
    conversations: snapshot.conversations.map(mapConversationFromPersistence),
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

export async function saveProject(project: AppProject): Promise<AppProject> {
  const savedProject = await invoke<PersistedProject>("save_project", {
    project: mapProjectToPersistence(project),
  });
  return mapProjectFromPersistence(savedProject);
}

export async function deleteStoredProject(projectId: string): Promise<void> {
  await invoke("delete_project", { projectId });
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
  };
}

function mapProjectToPersistence(project: AppProject): PersistedProject {
  return {
    ...project,
    path: project.path ?? null,
  };
}

function mapConversationFromPersistence(conversation: PersistedChatConversation): ChatConversation {
  return {
    ...conversation,
    messages: conversation.messages.map(mapMessageFromPersistence),
  };
}

function mapConversationToPersistence(conversation: ChatConversation): PersistedChatConversation {
  return {
    ...conversation,
    messages: conversation.messages.map(mapMessageToPersistence),
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
    ...message,
    status: message.status ?? null,
  };
}
