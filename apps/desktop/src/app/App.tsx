import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { ResizeHandle } from "../components/layout/ResizeHandle";
import { LeftSidebar } from "../components/sidebar/LeftSidebar";
import { RightSidebar } from "../components/sidebar/RightSidebar";
import { useFrontendConfig } from "../config/FrontendConfigProvider";
import { useModelSettings } from "../config/ModelSettingsProvider";
import { useProjectSettings } from "../config/ProjectSettingsProvider";
import { sendAgentMessage } from "../features/agent/agentClient";
import { ChatConversationPage } from "../features/chat/ChatConversationPage";
import { NewConversationPage } from "../features/chat/NewConversationPage";
import type { ChatConversation, ChatMessage, ChatSubmitOptions } from "../features/chat/chatTypes";
import { loadConversations, saveConversation } from "../features/storage/storageClient";
import { SettingsPage } from "../features/settings/SettingsPage";

const LEFT_DEFAULT_WIDTH = 288;
const RIGHT_DEFAULT_WIDTH = 360;
const LEFT_MIN_WIDTH = 220;
const RIGHT_MIN_WIDTH = 280;
const SIDE_MAX_WIDTH = 560;
const CENTER_MIN_WIDTH = 480;

type Side = "left" | "right";
type AppView = "workspace" | "settings";
type WorkspaceView = "blank" | "newConversation" | "conversation";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createConversationTitle(message: string) {
  const firstLine = message.split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() || "新对话";
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}...` : firstLine;
}

function createUserMessage(content: string): ChatMessage {
  return {
    id: createId("message"),
    role: "user",
    content,
    createdAt: Date.now(),
    status: "sent",
  };
}

function createAssistantMessage(content: string, status: ChatMessage["status"] = "sent"): ChatMessage {
  return {
    id: createId("message"),
    role: "assistant",
    content,
    createdAt: Date.now(),
    status,
  };
}

function getErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "请求失败，请检查 API 配置后重试。";
}

export function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const cancelledPendingMessageIdsRef = useRef<Set<string>>(new Set());
  const { t } = useFrontendConfig();
  const { apiToken, apiUrl, models } = useModelSettings();
  const { hasLoadedProjects, projects } = useProjectSettings();
  const [view, setView] = useState<AppView>("workspace");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("blank");
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [hasLoadedConversations, setHasLoadedConversations] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [newConversationProjectId, setNewConversationProjectId] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT_WIDTH);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT_WIDTH);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const resizeSide = useCallback(
    (side: Side, deltaX: number) => {
      const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth;
      const otherWidth = side === "left" ? (rightOpen ? rightWidth : 0) : leftOpen ? leftWidth : 0;
      const minimum = side === "left" ? LEFT_MIN_WIDTH : RIGHT_MIN_WIDTH;
      const availableMax = Math.max(minimum, shellWidth - otherWidth - CENTER_MIN_WIDTH);
      const maximum = Math.min(SIDE_MAX_WIDTH, availableMax);

      if (side === "left") {
        setLeftWidth((current) => clamp(current + deltaX, minimum, maximum));
      } else {
        setRightWidth((current) => clamp(current - deltaX, minimum, maximum));
      }
    },
    [leftOpen, leftWidth, rightOpen, rightWidth],
  );

  useEffect(() => {
    const keepCenterVisible = () => {
      const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth;
      if (shellWidth < 920 && rightOpen) setRightOpen(false);
      if (shellWidth < 680 && leftOpen) setLeftOpen(false);
    };

    keepCenterVisible();
    window.addEventListener("resize", keepCenterVisible);
    return () => window.removeEventListener("resize", keepCenterVisible);
  }, [leftOpen, rightOpen]);

  useEffect(() => {
    let isCancelled = false;

    void loadConversations()
      .then((storedConversations) => {
        if (!isCancelled) {
          setConversations(storedConversations);
        }
      })
      .catch((error) => {
        console.error("Failed to load conversations from SQLite", error);
      })
      .finally(() => {
        if (!isCancelled) {
          setHasLoadedConversations(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedConversations) return;

    conversations.forEach((conversation) => {
      void saveConversation(conversation).catch((error) => {
        console.error("Failed to save conversation to SQLite", error);
      });
    });
  }, [conversations, hasLoadedConversations]);

  useEffect(() => {
    if (!hasLoadedConversations || !hasLoadedProjects) return;

    const projectIds = new Set(projects.map((project) => project.id));
    const removedConversationIds = conversations
      .filter((conversation) => conversation.projectId && !projectIds.has(conversation.projectId))
      .map((conversation) => conversation.id);

    if (removedConversationIds.length === 0) return;

    setConversations((currentConversations) =>
      currentConversations.filter(
        (conversation) => !conversation.projectId || projectIds.has(conversation.projectId),
      ),
    );

    if (activeConversationId && removedConversationIds.includes(activeConversationId)) {
      setActiveConversationId(null);
      setWorkspaceView("blank");
    }

    if (newConversationProjectId && !projectIds.has(newConversationProjectId)) {
      setNewConversationProjectId(null);
    }
  }, [
    activeConversationId,
    conversations,
    hasLoadedConversations,
    hasLoadedProjects,
    newConversationProjectId,
    projects,
  ]);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const toolbarTitle = workspaceView === "conversation" ? activeConversation?.title : undefined;

  const startNewConversation = useCallback((projectId: string | null = null) => {
    setNewConversationProjectId(projectId);
    setActiveConversationId(null);
    setWorkspaceView("newConversation");
  }, []);

  const requestAssistantResponse = useCallback(
    async (
      conversationId: string,
      pendingMessageId: string,
      history: ChatMessage[],
      modelId: string,
      projectId: string | null,
    ) => {
      const model = models.find((candidate) => candidate.id === modelId);
      const apiModelId = model?.providerPath ?? model?.id ?? modelId;
      const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined;

      try {
        const content = await sendAgentMessage({
          apiToken,
          apiUrl,
          context: {
            conversationId,
            projectId,
            workspace: project
              ? {
                  projectId: project.id,
                  displayName: project.name,
                  rootPath: project.path,
                }
              : undefined,
          },
          maxTokens: 1024,
          messages: history,
          model: apiModelId,
        });

        if (cancelledPendingMessageIdsRef.current.has(pendingMessageId)) {
          cancelledPendingMessageIdsRef.current.delete(pendingMessageId);
          return;
        }

        setConversations((currentConversations) =>
          currentConversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  messages: conversation.messages.map((message) =>
                    message.id === pendingMessageId
                      ? {
                          ...message,
                          content,
                          status: "sent",
                        }
                      : message,
                  ),
                  updatedAt: Date.now(),
                }
              : conversation,
          ),
        );
      } catch (error) {
        if (cancelledPendingMessageIdsRef.current.has(pendingMessageId)) {
          cancelledPendingMessageIdsRef.current.delete(pendingMessageId);
          return;
        }

        setConversations((currentConversations) =>
          currentConversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  messages: conversation.messages.map((message) =>
                    message.id === pendingMessageId
                      ? {
                          ...message,
                          content: getErrorMessage(error),
                          status: "error",
                        }
                      : message,
                  ),
                  updatedAt: Date.now(),
                }
              : conversation,
          ),
        );
      }
    },
    [apiToken, apiUrl, models, projects],
  );

  const createConversationFromMessage = useCallback(
    (content: string, options: ChatSubmitOptions) => {
      const now = Date.now();
      const userMessage = createUserMessage(content);
      const pendingMessage = createAssistantMessage("正在思考...", "pending");
      const conversation: ChatConversation = {
        id: createId("conversation"),
        modelId: options.modelId,
        projectId: options.projectId,
        title: createConversationTitle(content),
        messages: [userMessage, pendingMessage],
        createdAt: now,
        updatedAt: now,
      };

      setConversations((currentConversations) => [conversation, ...currentConversations]);
      setActiveConversationId(conversation.id);
      setNewConversationProjectId(null);
      setWorkspaceView("conversation");
      void requestAssistantResponse(
        conversation.id,
        pendingMessage.id,
        [userMessage],
        options.modelId,
        options.projectId,
      );
    },
    [requestAssistantResponse],
  );

  const appendMessageToActiveConversation = useCallback(
    (content: string, options: ChatSubmitOptions) => {
      if (!activeConversationId) {
        createConversationFromMessage(content, options);
        return;
      }

      const activeConversationSnapshot = conversations.find((conversation) => conversation.id === activeConversationId);
      if (!activeConversationSnapshot) {
        createConversationFromMessage(content, options);
        return;
      }

      const userMessage = createUserMessage(content);
      const pendingMessage = createAssistantMessage("正在思考...", "pending");
      const now = Date.now();
      const requestHistory = [
        ...activeConversationSnapshot.messages.filter(
          (message) => message.status !== "pending" && message.status !== "error",
        ),
        userMessage,
      ];

      setConversations((currentConversations) =>
        currentConversations.map((conversation) =>
          conversation.id === activeConversationId
            ? {
                ...conversation,
                modelId: options.modelId,
                messages: [...conversation.messages, userMessage, pendingMessage],
                updatedAt: now,
              }
            : conversation,
        ),
      );

      void requestAssistantResponse(
        activeConversationId,
        pendingMessage.id,
        requestHistory,
        options.modelId,
        activeConversationSnapshot.projectId,
      );
    },
    [activeConversationId, conversations, createConversationFromMessage, requestAssistantResponse],
  );

  const selectConversation = useCallback((conversationId: string) => {
    setActiveConversationId(conversationId);
    setWorkspaceView("conversation");
  }, []);

  const stopActiveGeneration = useCallback(() => {
    if (!activeConversationId) return;

    const activeConversationSnapshot = conversations.find((conversation) => conversation.id === activeConversationId);
    const pendingMessage = [...(activeConversationSnapshot?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "pending");

    if (!pendingMessage) return;

    cancelledPendingMessageIdsRef.current.add(pendingMessage.id);
    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === pendingMessage.id
                  ? {
                      ...message,
                      content: "已停止生成。",
                      status: "sent",
                    }
                  : message,
              ),
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    );
  }, [activeConversationId, conversations]);

  if (view === "settings") {
    return <SettingsPage onBack={() => setView("workspace")} />;
  }

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-left-open={leftOpen}
      data-right-open={rightOpen}
      style={{
        "--left-panel-width": `${leftOpen ? leftWidth : 0}px`,
        "--right-panel-width": `${rightOpen ? rightWidth : 0}px`,
      } as React.CSSProperties}
    >
      <header className="window-toolbar" data-tauri-drag-region />

      <div className="side-panel side-panel--left">
        <LeftSidebar
          isNewConversationActive={workspaceView === "newConversation"}
          activeConversationId={activeConversationId}
          conversations={conversations}
          projects={projects}
          onNewConversation={startNewConversation}
          onOpenSettings={() => setView("settings")}
          onSelectConversation={selectConversation}
        />
      </div>

      {leftOpen && (
        <ResizeHandle
          side="left"
          onResize={(deltaX) => resizeSide("left", deltaX)}
        />
      )}

      <main className="main-panel" aria-label={t("app.mainWorkspace")}>
        <div className="main-panel__toolbar" data-tauri-drag-region>
          <button
            className="panel-toggle panel-toggle--left"
            type="button"
            aria-label={leftOpen ? t("app.collapseLeftSidebar") : t("app.expandLeftSidebar")}
            aria-pressed={leftOpen}
            onClick={() => setLeftOpen((value) => !value)}
          >
            {leftOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </button>

          <button
            className="panel-toggle panel-toggle--right"
            type="button"
            aria-label={rightOpen ? t("app.collapseRightSidebar") : t("app.expandRightSidebar")}
            aria-pressed={rightOpen}
            onClick={() => setRightOpen((value) => !value)}
          >
            {rightOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </button>

          {toolbarTitle && <h1 className="main-panel__title">{toolbarTitle}</h1>}
        </div>
        <div className="main-panel__surface">
          {workspaceView === "newConversation" && (
            <NewConversationPage defaultProjectId={newConversationProjectId} onSubmitMessage={createConversationFromMessage} />
          )}
          {workspaceView === "conversation" && activeConversation && (
            <ChatConversationPage
              conversation={activeConversation}
              onStopGenerating={stopActiveGeneration}
              onSubmitMessage={appendMessageToActiveConversation}
            />
          )}
        </div>
      </main>

      {rightOpen && (
        <ResizeHandle
          side="right"
          onResize={(deltaX) => resizeSide("right", deltaX)}
        />
      )}

      <div className="side-panel side-panel--right">
        <RightSidebar />
      </div>
    </div>
  );
}
