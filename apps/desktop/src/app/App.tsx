import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { ResizeHandle } from "../components/layout/ResizeHandle";
import { LeftSidebar } from "../components/sidebar/LeftSidebar";
import { RightSidebar } from "../components/sidebar/RightSidebar";
import { useFrontendConfig } from "../config/FrontendConfigProvider";
import { modelConfig } from "../config/modelConfig";
import { useProjectSettings } from "../config/ProjectSettingsProvider";
import {
  approveAgentAction,
  cancelAgentAction,
  rejectAgentAction,
  startConversationTurn,
} from "../features/agent/agentClient";
import { ChatConversationPage } from "../features/chat/ChatConversationPage";
import { NewConversationPage } from "../features/chat/NewConversationPage";
import type {
  ChatAgentCommandOutput,
  ChatAgentRunView,
  ChatAgentTimelineItem,
  ChatComposerDraft,
  ChatConversation,
  ChatMessage,
  ChatSubmitOptions,
} from "../features/chat/chatTypes";
import {
  deleteStoredComposerDraft,
  deleteStoredConversation,
  defaultUiPreferences,
  loadComposerDrafts,
  loadConversations,
  loadUiPreferences,
  saveComposerDraft,
  saveConversation,
  saveUiPreferences,
} from "../features/storage/storageClient";
import type { UiPreferencesSnapshot } from "../features/storage/storageClient";
import { SettingsPage } from "../features/settings/SettingsPage";
import type {
  AgentActionExecutionOutput,
  AgentChatOutput,
  AgentCommandExecutionResult,
  AgentConversationMessage,
  AgentConversationTurnInput,
  AgentEvent,
  AgentInputAttachment,
  AgentProposedAction,
} from "@agent";

const LEFT_DEFAULT_WIDTH = 288;
const RIGHT_DEFAULT_WIDTH = 360;
const LEFT_MIN_WIDTH = 220;
const RIGHT_MIN_WIDTH = 280;
const SIDE_MAX_WIDTH = 560;
const CENTER_MIN_WIDTH = 480;
const NEW_CONVERSATION_DRAFT_ID = "new-conversation";

type Side = "left" | "right";
type AppView = "workspace" | "settings";
type WorkspaceView = "newConversation" | "conversation";
type ActiveRunBinding = {
  conversationId: string;
  pendingMessageId: string;
};

const THINKING_PLACEHOLDER = "正在思考...";

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

function createComposerDraft(
  overrides: Partial<ChatComposerDraft> = {},
): ChatComposerDraft {
  const draft = {
    message: "",
    permissionMode: "full",
    modelId: modelConfig.defaults.selectedModelId,
    projectId: null,
    attachments: [],
    updatedAt: Date.now(),
    ...overrides,
  };

  return {
    ...draft,
    modelId: draft.modelId || modelConfig.defaults.selectedModelId,
    permissionMode: draft.permissionMode === "default" ? "default" : "full",
    attachments: draft.attachments ?? [],
  };
}

function getChatMessageStatusFromConversationMessage(
  status: AgentConversationMessage["status"],
): ChatMessage["status"] {
  return status ?? undefined;
}

function mergeConversationMessageFromBackend(
  currentMessage: ChatMessage,
  backendMessage: AgentConversationMessage,
): ChatMessage {
  return {
    ...currentMessage,
    id: backendMessage.id,
    role: backendMessage.role,
    content: backendMessage.content,
    createdAt: backendMessage.createdAt,
    status: getChatMessageStatusFromConversationMessage(backendMessage.status),
  };
}

function createAgentRun(runId: string | null, status: ChatAgentRunView["status"] = "starting"): ChatAgentRunView {
  return {
    runId,
    status,
    toolDefinitions: [],
    toolCalls: [],
    toolResults: [],
    approvals: [],
    diffs: [],
    commandOutputs: [],
    timeline: [],
  };
}

function ensureAgentRun(
  currentRun: ChatAgentRunView | undefined,
  runId: string | null | undefined,
  status?: ChatAgentRunView["status"],
): ChatAgentRunView {
  if (!currentRun) {
    return createAgentRun(runId ?? null, status);
  }

  return {
    ...currentRun,
    runId: currentRun.runId ?? runId ?? null,
    status: status ?? currentRun.status,
    timeline: currentRun.timeline ?? [],
  };
}

function upsertById<T>(items: T[], nextItem: T, getId: (item: T) => string) {
  const nextId = getId(nextItem);
  const itemIndex = items.findIndex((item) => getId(item) === nextId);

  if (itemIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item, index) => (index === itemIndex ? nextItem : item));
}

function getAgentActionId(action: AgentProposedAction) {
  if (action.type === "diff") return action.diff.id;
  if (action.type === "command") return action.command.id;
  return action.call.id;
}

function upsertAgentAction(actions: AgentProposedAction[], nextAction: AgentProposedAction) {
  return upsertById(actions, nextAction, getAgentActionId);
}

function appendTimelineItem(run: ChatAgentRunView, item: ChatAgentTimelineItem): ChatAgentTimelineItem[] {
  if (run.timeline.some((timelineItem) => timelineItem.id === item.id)) {
    return run.timeline.map((timelineItem) => (timelineItem.id === item.id ? item : timelineItem));
  }

  return [...run.timeline, item];
}

function appendApprovalActionsToTimeline(
  timeline: ChatAgentTimelineItem[],
  actions: AgentProposedAction[],
): ChatAgentTimelineItem[] {
  return actions.reduce((currentTimeline, action) => {
    const actionId = getAgentActionId(action);
    const timelineItem: ChatAgentTimelineItem = {
      id: `approval-${actionId}`,
      type: "approval",
      actionId,
    };

    if (currentTimeline.some((item) => item.id === timelineItem.id)) {
      return currentTimeline.map((item) => (item.id === timelineItem.id ? timelineItem : item));
    }

    return [...currentTimeline, timelineItem];
  }, timeline);
}

function appendMessageDeltaToTimeline(run: ChatAgentRunView, delta: string): ChatAgentTimelineItem[] {
  const lastItem = run.timeline[run.timeline.length - 1];

  if (lastItem?.type === "message") {
    return run.timeline.map((timelineItem) =>
      timelineItem.id === lastItem.id && timelineItem.type === "message"
        ? {
            ...timelineItem,
            content: `${timelineItem.content}${delta}`,
          }
        : timelineItem,
    );
  }

  return [
    ...run.timeline,
    {
      id: `message-${run.timeline.length + 1}`,
      type: "message",
      content: delta,
    },
  ];
}

function appendMessageToTimeline(run: ChatAgentRunView, content: string): ChatAgentTimelineItem[] {
  const lastItem = run.timeline[run.timeline.length - 1];

  if (lastItem?.type === "message") {
    return run.timeline.map((timelineItem) =>
      timelineItem.id === lastItem.id && timelineItem.type === "message"
        ? {
            ...timelineItem,
            content,
          }
        : timelineItem,
    );
  }

  return [
    ...run.timeline,
    {
      id: `message-${run.timeline.length + 1}`,
      type: "message",
      content,
    },
  ];
}

function getMessageContentAfterDelta(content: string, delta: string) {
  const previousContent = content === THINKING_PLACEHOLDER ? "" : content;
  return `${previousContent}${delta}`;
}

function getFinalMessageContent(currentContent: string, finalContent?: string) {
  if (!finalContent) {
    return currentContent === THINKING_PLACEHOLDER ? "" : currentContent;
  }

  if (!currentContent || currentContent === THINKING_PLACEHOLDER) {
    return finalContent;
  }

  return currentContent;
}

function getChatMessageStatusFromAgentStatus(status: AgentChatOutput["status"]): ChatMessage["status"] {
  if (status === "running" || status === "waiting_for_approval" || status === "idle") return "pending";
  if (status === "failed" || status === "cancelled") return "error";
  return "sent";
}

function applyAgentEventToChatMessage(message: ChatMessage, agentEvent: AgentEvent): ChatMessage {
  const runId = agentEvent.runId ?? message.agentRun?.runId ?? null;
  const currentRun = ensureAgentRun(message.agentRun, runId);

  if (agentEvent.type === "started") {
    return {
      ...message,
      status: "pending",
      agentRun: {
        ...currentRun,
        runId: agentEvent.runId,
        status: "running",
        toolDefinitions: agentEvent.toolDefinitions,
      },
    };
  }

  if (agentEvent.type === "state") {
    return {
      ...message,
      status: getChatMessageStatusFromAgentStatus(agentEvent.state.status),
      agentRun: {
        ...currentRun,
        status: agentEvent.state.status,
        state: agentEvent.state,
        error: agentEvent.state.lastError ?? currentRun.error,
      },
    };
  }

  if (agentEvent.type === "message_delta") {
    return {
      ...message,
      content: getMessageContentAfterDelta(message.content, agentEvent.delta),
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        timeline: appendMessageDeltaToTimeline(currentRun, agentEvent.delta),
      },
    };
  }

  if (agentEvent.type === "message") {
    return {
      ...message,
      content: agentEvent.content,
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        timeline: appendMessageToTimeline(currentRun, agentEvent.content),
      },
    };
  }

  if (agentEvent.type === "tool_call") {
    return {
      ...message,
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        toolCalls: upsertById(currentRun.toolCalls, agentEvent.call, (call) => call.id),
        timeline: appendTimelineItem(currentRun, {
          id: `tool-call-${agentEvent.call.id}`,
          type: "tool_call",
          callId: agentEvent.call.id,
        }),
      },
    };
  }

  if (agentEvent.type === "tool_result") {
    return {
      ...message,
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        toolResults: upsertById(currentRun.toolResults, agentEvent.result, (result) => result.callId),
      },
    };
  }

  if (agentEvent.type === "approval_required") {
    return {
      ...message,
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "waiting_for_approval",
        approvals: upsertAgentAction(currentRun.approvals, agentEvent.action),
        timeline: appendTimelineItem(currentRun, {
          id: `approval-${getAgentActionId(agentEvent.action)}`,
          type: "approval",
          actionId: getAgentActionId(agentEvent.action),
        }),
      },
    };
  }

  if (agentEvent.type === "diff") {
    return {
      ...message,
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        diffs: upsertById(currentRun.diffs, agentEvent.diff, (diff) => diff.id),
        timeline: appendTimelineItem(currentRun, {
          id: `diff-${agentEvent.diff.id}`,
          type: "diff",
          diffId: agentEvent.diff.id,
        }),
      },
    };
  }

  if (agentEvent.type === "command_output") {
    const commandOutput: ChatAgentCommandOutput = {
      id: `${agentEvent.runId}-command-output-${currentRun.commandOutputs.length + 1}`,
      command: agentEvent.command,
      stream: agentEvent.stream,
      output: agentEvent.output,
    };

    return {
      ...message,
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        commandOutputs: [...currentRun.commandOutputs, commandOutput],
        timeline: appendTimelineItem(currentRun, {
          id: `command-output-${commandOutput.id}`,
          type: "command_output",
          outputId: commandOutput.id,
        }),
      },
    };
  }

  if (agentEvent.type === "error") {
    return {
      ...message,
      content: agentEvent.recoverable ? message.content : agentEvent.message,
      status: agentEvent.recoverable ? message.status : "error",
      agentRun: {
        ...currentRun,
        status: agentEvent.recoverable ? currentRun.status : "failed",
        error: agentEvent.message,
        timeline: appendTimelineItem(currentRun, {
          id: `error-${currentRun.timeline.length + 1}`,
          type: "error",
          message: agentEvent.message,
        }),
      },
    };
  }

  const nextStatus = agentEvent.status ?? (agentEvent.success ? "completed" : "failed");
  const proposedActions = agentEvent.proposedActions ?? [];

  return {
    ...message,
    content: getFinalMessageContent(message.content, agentEvent.content),
    status: nextStatus === "waiting_for_approval" ? "pending" : agentEvent.success ? "sent" : "error",
    agentRun: {
      ...currentRun,
      status: nextStatus,
      usage: agentEvent.usage,
      finishReason: agentEvent.finishReason,
      approvals: proposedActions.reduce(upsertAgentAction, currentRun.approvals),
      timeline: appendApprovalActionsToTimeline(currentRun.timeline, proposedActions),
    },
  };
}

function applyAgentOutputToChatMessage(message: ChatMessage, output: AgentChatOutput): ChatMessage {
  const streamedContentEvents = output.events.some(
    (event) => event.type === "message" || event.type === "message_delta",
  );
  const messageWithEvents = output.events.reduce(applyAgentEventToChatMessage, message);
  const currentRun = ensureAgentRun(messageWithEvents.agentRun, output.runId, output.status);
  const nextContent =
    output.content && (!streamedContentEvents || !messageWithEvents.content || messageWithEvents.content === THINKING_PLACEHOLDER)
      ? output.content
      : messageWithEvents.content;

  return {
    ...messageWithEvents,
    content: nextContent,
    status: getChatMessageStatusFromAgentStatus(output.status),
    agentRun: {
      ...currentRun,
      status: output.status,
      toolDefinitions: output.toolDefinitions,
      usage: output.usage,
      finishReason: output.finishReason,
      approvals: output.proposedActions.reduce(upsertAgentAction, currentRun.approvals),
      timeline: appendApprovalActionsToTimeline(currentRun.timeline, output.proposedActions),
    },
  };
}

function createCommandOutputsFromExecution(
  actionId: string,
  commandResult: AgentCommandExecutionResult,
): ChatAgentCommandOutput[] {
  const outputs: ChatAgentCommandOutput[] = [];

  if (commandResult.stdout) {
    outputs.push({
      id: `${actionId}-stdout`,
      command: commandResult.command,
      stream: "stdout",
      output: commandResult.stdout,
    });
  }

  if (commandResult.stderr) {
    outputs.push({
      id: `${actionId}-stderr`,
      command: commandResult.command,
      stream: "stderr",
      output: commandResult.stderr,
    });
  }

  if (outputs.length === 0 && commandResult.error) {
    outputs.push({
      id: `${actionId}-error`,
      command: commandResult.command,
      stream: "stderr",
      output: commandResult.error,
    });
  }

  return outputs;
}

function applyAgentActionExecutionToChatMessage(
  message: ChatMessage,
  execution: AgentActionExecutionOutput,
): ChatMessage {
  const messageWithAgentOutput = applyAgentOutputToChatMessage(message, execution.agentOutput);

  if (!execution.commandResult) {
    return messageWithAgentOutput;
  }

  const currentRun = ensureAgentRun(messageWithAgentOutput.agentRun, execution.agentOutput.runId);
  const commandOutputs = createCommandOutputsFromExecution(execution.actionId, execution.commandResult);

  return {
    ...messageWithAgentOutput,
    agentRun: {
      ...currentRun,
      commandOutputs: [...currentRun.commandOutputs, ...commandOutputs],
      timeline: [
        ...currentRun.timeline,
        ...commandOutputs.map(
          (output): ChatAgentTimelineItem => ({
            id: `command-output-${output.id}`,
            type: "command_output",
            outputId: output.id,
          }),
        ),
      ],
    },
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
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());
  const activeRunBindingsRef = useRef<Map<string, ActiveRunBinding>>(new Map());
  const bufferedAgentEventsRef = useRef<Map<string, AgentEvent[]>>(new Map());
  const { t } = useFrontendConfig();
  const {
    deleteProject,
    hasLoadedProjects,
    projects,
    renameProject,
    showProjectInFolder,
    togglePinProject,
  } = useProjectSettings();
  const [view, setView] = useState<AppView>("workspace");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("newConversation");
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [hasLoadedConversations, setHasLoadedConversations] = useState(false);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ChatComposerDraft>>({});
  const [hasLoadedComposerDrafts, setHasLoadedComposerDrafts] = useState(false);
  const [uiPreferences, setUiPreferences] = useState<UiPreferencesSnapshot>(() => defaultUiPreferences());
  const [hasLoadedUiPreferences, setHasLoadedUiPreferences] = useState(false);
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
    let isCancelled = false;

    void loadUiPreferences()
      .then((storedPreferences) => {
        if (!isCancelled) {
          setUiPreferences(storedPreferences);
        }
      })
      .catch((error) => {
        console.error("Failed to load UI preferences from SQLite", error);
      })
      .finally(() => {
        if (!isCancelled) {
          setHasLoadedUiPreferences(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    void loadComposerDrafts()
      .then((storedDrafts) => {
        if (!isCancelled) {
          setComposerDrafts(storedDrafts);
        }
      })
      .catch((error) => {
        console.error("Failed to load composer drafts from SQLite", error);
      })
      .finally(() => {
        if (!isCancelled) {
          setHasLoadedComposerDrafts(true);
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
    if (!hasLoadedComposerDrafts) return;

    Object.entries(composerDrafts).forEach(([scopeId, draft]) => {
      void saveComposerDraft(scopeId, draft).catch((error) => {
        console.error("Failed to save composer draft to SQLite", error);
      });
    });
  }, [composerDrafts, hasLoadedComposerDrafts]);

  useEffect(() => {
    if (!hasLoadedUiPreferences) return;

    void saveUiPreferences(uiPreferences).catch((error) => {
      console.error("Failed to save UI preferences to SQLite", error);
    });
  }, [hasLoadedUiPreferences, uiPreferences]);

  useEffect(() => {
    if (!hasLoadedConversations || !hasLoadedProjects) return;

    const projectIds = new Set(projects.map((project) => project.id));
    const removedConversationIds = conversations
      .filter((conversation) => conversation.projectId && !projectIds.has(conversation.projectId))
      .map((conversation) => conversation.id);

    if (removedConversationIds.length === 0) return;

    removedConversationIds.forEach((conversationId) => {
      void deleteStoredComposerDraft(conversationId).catch((error) => {
        console.error("Failed to delete removed project conversation draft from SQLite", error);
      });
    });

    setConversations((currentConversations) =>
      currentConversations.filter(
        (conversation) => !conversation.projectId || projectIds.has(conversation.projectId),
      ),
    );
    setComposerDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      removedConversationIds.forEach((conversationId) => {
        delete nextDrafts[conversationId];
      });

      const newConversationProjectId = nextDrafts[NEW_CONVERSATION_DRAFT_ID]?.projectId;
      if (newConversationProjectId && !projectIds.has(newConversationProjectId)) {
        nextDrafts[NEW_CONVERSATION_DRAFT_ID] = {
          ...nextDrafts[NEW_CONVERSATION_DRAFT_ID],
          projectId: null,
          updatedAt: Date.now(),
        };
      }

      return nextDrafts;
    });

    if (activeConversationId && removedConversationIds.includes(activeConversationId)) {
      setActiveConversationId(null);
      setWorkspaceView("newConversation");
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
  const getComposerDraft = useCallback(
    (
      scopeId: string,
      defaults: Partial<Pick<ChatComposerDraft, "modelId" | "projectId" | "permissionMode">> = {},
    ) => composerDrafts[scopeId] ?? createComposerDraft(defaults),
    [composerDrafts],
  );
  const updateComposerDraft = useCallback((scopeId: string, draft: ChatComposerDraft) => {
    setComposerDrafts((currentDrafts) => ({
      ...currentDrafts,
      [scopeId]: draft,
    }));
  }, []);
  const updateUiPreferences = useCallback((patch: Partial<UiPreferencesSnapshot>) => {
    setUiPreferences((currentPreferences) => ({
      ...currentPreferences,
      ...patch,
      updatedAt: Date.now(),
    }));
  }, []);
  const newConversationDraft = getComposerDraft(NEW_CONVERSATION_DRAFT_ID, {
    projectId: newConversationProjectId,
  });
  const activeConversationDraft = activeConversation
    ? getComposerDraft(activeConversation.id, {
        modelId: activeConversation.modelId ?? undefined,
        projectId: activeConversation.projectId,
      })
    : null;

  const cleanupRunBinding = useCallback((runId: string) => {
    activeRunBindingsRef.current.delete(runId);
    bufferedAgentEventsRef.current.delete(runId);
  }, []);

  const startNewConversation = useCallback((projectId: string | null = null) => {
    setNewConversationProjectId(projectId);
    setComposerDrafts((currentDrafts) => ({
      ...currentDrafts,
      [NEW_CONVERSATION_DRAFT_ID]: {
        ...(currentDrafts[NEW_CONVERSATION_DRAFT_ID] ?? createComposerDraft()),
        projectId,
        updatedAt: Date.now(),
      },
    }));
    setActiveConversationId(null);
    setWorkspaceView("newConversation");
  }, []);

  const updateAssistantMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
    ) => {
      setConversations((currentConversations) =>
        currentConversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.id === messageId ? updater(message) : message,
                ),
                updatedAt: Date.now(),
              }
            : conversation,
        ),
      );
    },
    [],
  );

  const applyAgentOutputToMessage = useCallback(
    (conversationId: string, messageId: string, output: AgentChatOutput) => {
      updateAssistantMessage(conversationId, messageId, (message) =>
        applyAgentOutputToChatMessage(message, output),
      );

      if (output.status !== "waiting_for_approval") {
        cleanupRunBinding(output.runId);
      }
    },
    [cleanupRunBinding, updateAssistantMessage],
  );

  const applyAgentExecutionToMessage = useCallback(
    (conversationId: string, messageId: string, execution: AgentActionExecutionOutput) => {
      updateAssistantMessage(conversationId, messageId, (message) =>
        applyAgentActionExecutionToChatMessage(message, execution),
      );

      if (execution.agentOutput.status !== "waiting_for_approval") {
        cleanupRunBinding(execution.agentOutput.runId);
      }
    },
    [cleanupRunBinding, updateAssistantMessage],
  );

  const handleAgentEvent = useCallback(
    (conversationId: string, pendingMessageId: string, agentEvent: AgentEvent) => {
      if (agentEvent.runId && cancelledRunIdsRef.current.has(agentEvent.runId)) return;
      if (cancelledPendingMessageIdsRef.current.has(pendingMessageId)) return;

      updateAssistantMessage(conversationId, pendingMessageId, (message) =>
        applyAgentEventToChatMessage(message, agentEvent),
      );

      if (agentEvent.type === "done") {
        cleanupRunBinding(agentEvent.runId);
      }

      if (agentEvent.type === "error" && !agentEvent.recoverable && agentEvent.runId) {
        cleanupRunBinding(agentEvent.runId);
      }
    },
    [cleanupRunBinding, updateAssistantMessage],
  );

  useEffect(() => {
    let isDisposed = false;
    let unlistenAgentEvents: (() => void) | null = null;

    void listen<AgentEvent>("agent_event", (event) => {
      const agentEvent = event.payload;

      if (isDisposed) return;
      if (!agentEvent.runId) return;

      const binding = activeRunBindingsRef.current.get(agentEvent.runId);
      if (!binding) {
        const bufferedEvents = bufferedAgentEventsRef.current.get(agentEvent.runId) ?? [];
        bufferedAgentEventsRef.current.set(agentEvent.runId, [...bufferedEvents, agentEvent]);
        return;
      }

      handleAgentEvent(binding.conversationId, binding.pendingMessageId, agentEvent);
    }).then((unlisten) => {
      if (isDisposed) {
        unlisten();
        return;
      }

      unlistenAgentEvents = unlisten;
    });

    return () => {
      isDisposed = true;
      unlistenAgentEvents?.();
      activeRunBindingsRef.current.clear();
      bufferedAgentEventsRef.current.clear();
    };
  }, [handleAgentEvent]);

  const requestAssistantResponse = useCallback(
    async (
      conversationId: string,
      userMessageId: string,
      pendingMessageId: string,
      content: string,
      modelId: string,
      projectId: string | null,
      attachments: AgentInputAttachment[] | undefined,
      title?: string,
    ) => {
      const input: AgentConversationTurnInput = {
        assistantMessageId: pendingMessageId,
        content,
        conversationId,
        maxTokens: 1024,
        modelId,
        projectId,
        userMessageId,
      };
      if (attachments && attachments.length > 0) {
        input.attachments = attachments;
      }

      if (title) {
        input.title = title;
      }

      try {
        updateAssistantMessage(conversationId, pendingMessageId, (message) => ({
          ...message,
          agentRun: ensureAgentRun(message.agentRun, null, "starting"),
        }));

        const startOutput = await startConversationTurn(input);

        if (cancelledPendingMessageIdsRef.current.has(pendingMessageId)) {
          cancelledPendingMessageIdsRef.current.delete(pendingMessageId);
          return;
        }

        const resolvedConversationId = startOutput.conversationId;
        const resolvedAssistantMessageId = startOutput.assistantMessageId;

        setConversations((currentConversations) =>
          currentConversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  id: resolvedConversationId,
                  messages: conversation.messages.map((message) => {
                    if (message.id === userMessageId) {
                      return mergeConversationMessageFromBackend(message, startOutput.userMessage);
                    }

                    if (message.id === pendingMessageId) {
                      const mergedMessage = mergeConversationMessageFromBackend(
                        message,
                        startOutput.assistantMessage,
                      );

                      return {
                        ...mergedMessage,
                        content: mergedMessage.content || message.content || THINKING_PLACEHOLDER,
                        status: "pending",
                        agentRun: ensureAgentRun(mergedMessage.agentRun, startOutput.runId, "running"),
                      };
                    }

                    return message;
                  }),
                  updatedAt: Date.now(),
                }
              : conversation,
          ),
        );

        if (resolvedConversationId !== conversationId) {
          setComposerDrafts((currentDrafts) => {
            const draft = currentDrafts[conversationId];
            if (!draft) return currentDrafts;
            const nextDrafts = { ...currentDrafts, [resolvedConversationId]: draft };
            delete nextDrafts[conversationId];
            return nextDrafts;
          });

          setActiveConversationId((currentActiveConversationId) =>
            currentActiveConversationId === conversationId ? resolvedConversationId : currentActiveConversationId,
          );
        }

        activeRunBindingsRef.current.set(startOutput.runId, {
          conversationId: resolvedConversationId,
          pendingMessageId: resolvedAssistantMessageId,
        });

        const bufferedEvents = bufferedAgentEventsRef.current.get(startOutput.runId) ?? [];
        bufferedAgentEventsRef.current.delete(startOutput.runId);
        bufferedEvents.forEach((agentEvent) => {
          handleAgentEvent(resolvedConversationId, resolvedAssistantMessageId, agentEvent);
        });
      } catch (error) {
        if (cancelledPendingMessageIdsRef.current.has(pendingMessageId)) {
          cancelledPendingMessageIdsRef.current.delete(pendingMessageId);
          return;
        }

        updateAssistantMessage(conversationId, pendingMessageId, (message) => ({
          ...message,
          content: getErrorMessage(error),
          status: "error",
          agentRun: {
            ...ensureAgentRun(message.agentRun, null, "failed"),
            error: getErrorMessage(error),
          },
        }));
      }
    },
    [handleAgentEvent, updateAssistantMessage],
  );

  const createConversationFromMessage = useCallback(
    (content: string, options: ChatSubmitOptions) => {
      const now = Date.now();
      const title = createConversationTitle(content);
      const userMessage = createUserMessage(content);
      const pendingMessage = createAssistantMessage("正在思考...", "pending");
      const conversation: ChatConversation = {
        id: createId("conversation"),
        modelId: options.modelId,
        projectId: options.projectId,
        title,
        messages: [userMessage, pendingMessage],
        createdAt: now,
        updatedAt: now,
        pinnedAt: null,
        archivedAt: null,
      };

      setConversations((currentConversations) => [conversation, ...currentConversations]);
      setComposerDrafts((currentDrafts) => ({
        ...currentDrafts,
        [NEW_CONVERSATION_DRAFT_ID]: {
          ...(currentDrafts[NEW_CONVERSATION_DRAFT_ID] ?? createComposerDraft()),
          message: "",
          attachments: [],
          modelId: options.modelId,
          permissionMode: options.permissionMode,
          projectId: options.projectId,
          updatedAt: now,
        },
        [conversation.id]: createComposerDraft({
          modelId: options.modelId,
          permissionMode: options.permissionMode,
          projectId: options.projectId,
          updatedAt: now,
        }),
      }));
      setActiveConversationId(conversation.id);
      setNewConversationProjectId(null);
      setWorkspaceView("conversation");
      void requestAssistantResponse(
        conversation.id,
        userMessage.id,
        pendingMessage.id,
        content,
        options.modelId,
        options.projectId,
        options.attachments,
        title,
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
        userMessage.id,
        pendingMessage.id,
        content,
        options.modelId,
        activeConversationSnapshot.projectId,
        options.attachments,
      );
    },
    [activeConversationId, conversations, createConversationFromMessage, requestAssistantResponse],
  );

  const selectConversation = useCallback((conversationId: string) => {
    setActiveConversationId(conversationId);
    setWorkspaceView("conversation");
  }, []);

  const togglePinConversation = useCallback((conversationId: string) => {
    const now = Date.now();

    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              pinnedAt: conversation.pinnedAt ? null : now,
            }
          : conversation,
      ),
    );
  }, []);

  const archiveConversation = useCallback(
    (conversationId: string) => {
      const now = Date.now();

      setConversations((currentConversations) =>
        currentConversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                archivedAt: now,
              }
            : conversation,
        ),
      );

      if (activeConversationId === conversationId) {
        setActiveConversationId(null);
        setWorkspaceView("newConversation");
      }
    },
    [activeConversationId],
  );

  const archiveProjectConversations = useCallback(
    (projectId: string) => {
      const now = Date.now();
      const archivedConversationIds = conversations
        .filter((conversation) => conversation.projectId === projectId && !conversation.archivedAt)
        .map((conversation) => conversation.id);

      if (archivedConversationIds.length === 0) return;

      setConversations((currentConversations) =>
        currentConversations.map((conversation) =>
          conversation.projectId === projectId && !conversation.archivedAt
            ? {
                ...conversation,
                archivedAt: now,
              }
            : conversation,
        ),
      );

      if (activeConversationId && archivedConversationIds.includes(activeConversationId)) {
        setActiveConversationId(null);
        setWorkspaceView("newConversation");
      }
    },
    [activeConversationId, conversations],
  );

  const archiveAllProjectConversations = useCallback(() => {
    const now = Date.now();
    const projectIds = new Set(projects.map((project) => project.id));

    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.projectId && projectIds.has(conversation.projectId) && !conversation.archivedAt
          ? {
              ...conversation,
              archivedAt: now,
            }
          : conversation,
      ),
    );

    const activeConversationSnapshot = conversations.find((conversation) => conversation.id === activeConversationId);
    if (
      activeConversationSnapshot?.projectId &&
      projectIds.has(activeConversationSnapshot.projectId)
    ) {
      setActiveConversationId(null);
      setWorkspaceView("newConversation");
    }
  }, [activeConversationId, conversations, projects]);

  const archiveAllRootConversations = useCallback(() => {
    const now = Date.now();
    const projectIds = new Set(projects.map((project) => project.id));

    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        (!conversation.projectId || !projectIds.has(conversation.projectId)) && !conversation.archivedAt
          ? {
              ...conversation,
              archivedAt: now,
            }
          : conversation,
      ),
    );

    const activeConversationSnapshot = conversations.find((conversation) => conversation.id === activeConversationId);
    if (
      activeConversationSnapshot &&
      (!activeConversationSnapshot.projectId || !projectIds.has(activeConversationSnapshot.projectId))
    ) {
      setActiveConversationId(null);
      setWorkspaceView("newConversation");
    }
  }, [activeConversationId, conversations, projects]);

  const unarchiveConversation = useCallback((conversationId: string) => {
    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              archivedAt: null,
            }
          : conversation,
      ),
    );
  }, []);

  const deleteConversation = useCallback(
    (conversationId: string) => {
      setConversations((currentConversations) =>
        currentConversations.filter((conversation) => conversation.id !== conversationId),
      );

      void deleteStoredConversation(conversationId).catch((error) => {
        console.error("Failed to delete conversation from SQLite", error);
      });
      void deleteStoredComposerDraft(conversationId).catch((error) => {
        console.error("Failed to delete composer draft from SQLite", error);
      });
      setComposerDrafts((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };
        delete nextDrafts[conversationId];
        return nextDrafts;
      });

      if (activeConversationId === conversationId) {
        setActiveConversationId(null);
        setWorkspaceView("newConversation");
      }
    },
    [activeConversationId],
  );

  const deleteArchivedConversations = useCallback(() => {
    const archivedConversationIds = conversations
      .filter((conversation) => conversation.archivedAt)
      .map((conversation) => conversation.id);

    if (archivedConversationIds.length === 0) return;

    setConversations((currentConversations) =>
      currentConversations.filter((conversation) => !conversation.archivedAt),
    );

    archivedConversationIds.forEach((conversationId) => {
      void deleteStoredConversation(conversationId).catch((error) => {
        console.error("Failed to delete archived conversation from SQLite", error);
      });
      void deleteStoredComposerDraft(conversationId).catch((error) => {
        console.error("Failed to delete archived composer draft from SQLite", error);
      });
    });
    setComposerDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      archivedConversationIds.forEach((conversationId) => {
        delete nextDrafts[conversationId];
      });
      return nextDrafts;
    });

    if (activeConversationId && archivedConversationIds.includes(activeConversationId)) {
      setActiveConversationId(null);
      setWorkspaceView("newConversation");
    }
  }, [activeConversationId, conversations]);

  const handleShowProjectInFolder = useCallback(
    (projectId: string) => {
      void showProjectInFolder(projectId).catch((error) => {
        console.error("Failed to show project in folder", error);
      });
    },
    [showProjectInFolder],
  );

  const stopActiveGeneration = useCallback(() => {
    if (!activeConversationId) return;

    const activeConversationSnapshot = conversations.find((conversation) => conversation.id === activeConversationId);
    const pendingMessage = [...(activeConversationSnapshot?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "pending");

    if (!pendingMessage) return;

    cancelledPendingMessageIdsRef.current.add(pendingMessage.id);

    if (pendingMessage.agentRun?.runId) {
      cancelledRunIdsRef.current.add(pendingMessage.agentRun.runId);
      cleanupRunBinding(pendingMessage.agentRun.runId);
    }

    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === pendingMessage.id
                  ? {
                      ...message,
                      content: message.content && message.content !== THINKING_PLACEHOLDER ? message.content : "已停止生成。",
                      status: "sent",
                      agentRun: message.agentRun
                        ? {
                            ...message.agentRun,
                            status: "cancelled",
                          }
                        : message.agentRun,
                    }
                  : message,
              ),
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    );
  }, [activeConversationId, cleanupRunBinding, conversations]);

  const handleApproveAgentAction = useCallback(
    async (messageId: string, action: AgentProposedAction) => {
      if (!activeConversationId) return;

      try {
        const execution = await approveAgentAction(getAgentActionId(action));
        applyAgentExecutionToMessage(activeConversationId, messageId, execution);
      } catch (error) {
        updateAssistantMessage(activeConversationId, messageId, (message) => {
          const currentRun = ensureAgentRun(message.agentRun, null, "failed");

          return {
            ...message,
            status: "error",
            agentRun: {
              ...currentRun,
              error: getErrorMessage(error),
              timeline: appendTimelineItem(currentRun, {
                id: `error-${currentRun.timeline.length + 1}`,
                type: "error",
                message: getErrorMessage(error),
              }),
            },
          };
        });
      }
    },
    [activeConversationId, applyAgentExecutionToMessage, updateAssistantMessage],
  );

  const handleRejectAgentAction = useCallback(
    async (messageId: string, action: AgentProposedAction) => {
      if (!activeConversationId) return;

      try {
        const execution = await rejectAgentAction(getAgentActionId(action));
        applyAgentExecutionToMessage(activeConversationId, messageId, execution);
      } catch (error) {
        updateAssistantMessage(activeConversationId, messageId, (message) => {
          const currentRun = ensureAgentRun(message.agentRun, null, "failed");

          return {
            ...message,
            status: "error",
            agentRun: {
              ...currentRun,
              error: getErrorMessage(error),
              timeline: appendTimelineItem(currentRun, {
                id: `error-${currentRun.timeline.length + 1}`,
                type: "error",
                message: getErrorMessage(error),
              }),
            },
          };
        });
      }
    },
    [activeConversationId, applyAgentExecutionToMessage, updateAssistantMessage],
  );

  const handleCancelAgentAction = useCallback(
    async (messageId: string, action: AgentProposedAction) => {
      if (!activeConversationId) return;

      try {
        await cancelAgentAction(getAgentActionId(action));
        updateAssistantMessage(activeConversationId, messageId, (message) => {
          const currentRun = ensureAgentRun(message.agentRun, null, "cancelled");

          return {
            ...message,
            status: "sent",
            agentRun: {
              ...currentRun,
              status: "cancelled",
              timeline: appendTimelineItem(currentRun, {
                id: `cancel-${getAgentActionId(action)}`,
                type: "error",
                message: "已取消该操作。",
              }),
            },
          };
        });
      } catch (error) {
        updateAssistantMessage(activeConversationId, messageId, (message) => {
          const currentRun = ensureAgentRun(message.agentRun, null, "failed");

          return {
            ...message,
            status: "error",
            agentRun: {
              ...currentRun,
              error: getErrorMessage(error),
              timeline: appendTimelineItem(currentRun, {
                id: `error-${currentRun.timeline.length + 1}`,
                type: "error",
                message: getErrorMessage(error),
              }),
            },
          };
        });
      }
    },
    [activeConversationId, updateAssistantMessage],
  );

  if (view === "settings") {
    return (
      <SettingsPage
        conversations={conversations}
        projects={projects}
        onBack={() => setView("workspace")}
        onDeleteAllArchivedConversations={deleteArchivedConversations}
        onDeleteConversation={deleteConversation}
        onUnarchiveConversation={unarchiveConversation}
      />
    );
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
          uiPreferences={uiPreferences}
          onArchiveAllProjectConversations={archiveAllProjectConversations}
          onArchiveAllRootConversations={archiveAllRootConversations}
          onArchiveConversation={archiveConversation}
          onArchiveProjectConversations={archiveProjectConversations}
          onNewConversation={startNewConversation}
          onOpenSettings={() => setView("settings")}
          onRemoveProject={deleteProject}
          onRenameProject={renameProject}
          onShowProjectInFolder={handleShowProjectInFolder}
          onSelectConversation={selectConversation}
          onTogglePinConversation={togglePinConversation}
          onTogglePinProject={togglePinProject}
          onUiPreferencesChange={updateUiPreferences}
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
            <NewConversationPage
              defaultProjectId={newConversationProjectId}
              draft={newConversationDraft}
              onDraftChange={(draft) => updateComposerDraft(NEW_CONVERSATION_DRAFT_ID, draft)}
              onSubmitMessage={createConversationFromMessage}
            />
          )}
          {workspaceView === "conversation" && activeConversation && activeConversationDraft && (
            <ChatConversationPage
              composerDraft={activeConversationDraft}
              conversation={activeConversation}
              onApproveAgentAction={handleApproveAgentAction}
              onCancelAgentAction={handleCancelAgentAction}
              onComposerDraftChange={(draft) => updateComposerDraft(activeConversation.id, draft)}
              onRejectAgentAction={handleRejectAgentAction}
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
