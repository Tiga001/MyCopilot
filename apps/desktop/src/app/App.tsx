import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ResizeHandle } from "../components/layout/ResizeHandle";
import { LeftSidebar } from "../components/sidebar/LeftSidebar";
import { RightSidebar } from "../components/sidebar/RightSidebar";
import { useFrontendConfig } from "../config/FrontendConfigProvider";
import { useProjectSettings } from "../config/ProjectSettingsProvider";
import {
  approveAgentAction,
  cancelAgentAction,
  cancelAgentRun,
  rejectAgentAction,
  startConversationTurn,
} from "../features/agent/agentClient";
import { ChatConversationPage } from "../features/chat/ChatConversationPage";
import { NewConversationPage } from "../features/chat/NewConversationPage";
import { isMacOS } from "../lib/platform";
import type {
  ChatComposerDraft,
  ChatConversation,
  ChatMessage,
  ChatMessageUiState,
  ChatPermissionMode,
  ChatSubmitOptions,
} from "../features/chat/chatTypes";
import { resolveChatPermissions } from "../features/chat/chatPermissions";
import { cancelPendingReadActivities } from "../features/chat/agentReadActivities";
import { cancelPendingWebSearchActivities } from "../features/chat/agentWebSearch";
import {
  deleteStoredComposerDraft,
  deleteStoredConversation,
  defaultUiPreferences,
  loadComposerDrafts,
  loadConversations,
  loadUiPreferences,
  saveChatMessageState,
  saveComposerDraft,
  saveConversation,
  saveConversationMeta,
  saveUiPreferences,
  upsertChatMessages,
} from "../features/storage/storageClient";
import type { UiPreferencesSnapshot } from "../features/storage/storageClient";
import { SettingsPage } from "../features/settings/SettingsPage";
import type { SettingsPageId } from "../features/settings/SettingsPage";
import { getAgentActionId, getErrorMessage } from "./agentActionUtils";
import {
  appendTimelineItem,
  applyAgentActionDecisionToChatMessage,
  applyAgentActionExecutionToChatMessage,
  applyAgentEventToChatMessage,
  applyAgentOutputToChatMessage,
  ensureAgentRun,
  shouldTouchConversationForAgentEvent,
} from "./agentEventReducer";
import {
  CENTER_MIN_WIDTH,
  LEFT_DEFAULT_WIDTH,
  LEFT_MIN_WIDTH,
  NEW_CONVERSATION_DRAFT_ID,
  RIGHT_DEFAULT_WIDTH,
  RIGHT_MIN_WIDTH,
  SIDE_MAX_WIDTH,
  THINKING_PLACEHOLDER,
  clamp,
} from "./appConstants";
import type { ActiveRunBinding, AppView, Side, WorkspaceView } from "./appTypes";
import {
  createAssistantMessage,
  createComposerDraft,
  createConversationTitle,
  createId,
  createUserMessage,
  mergeConversationMessageFromBackend,
} from "./chatMessageFactory";
import type {
  AgentActionExecutionOutput,
  AgentChatOutput,
  AgentConversationTurnInput,
  AgentEvent,
  AgentInputAttachment,
  AgentProposedAction,
} from "@agent";

const STREAM_MESSAGE_SAVE_THROTTLE_MS = 900;
const DEFAULT_AGENT_MAX_TOKENS = 30000;
const SUPPORTS_NATIVE_FONT_SMOOTHING = isMacOS();
const AUTO_APPROVAL_MAX_STEPS = 16;

type AgentApprovalOptions = {
  rememberForRun?: boolean;
};

type AgentApprovalAutoRule =
  | {
      kind: "commandPrefix";
      prefix: string;
    }
  | {
      kind: "applyPatch";
    };

function getCommandApprovalPrefix(action: AgentProposedAction) {
  if (action.type !== "command") return "";
  return action.command.command.trim();
}

function shouldAutoApproveAgentAction(
  action: AgentProposedAction,
  rules: AgentApprovalAutoRule[],
) {
  if (action.type === "diff") {
    return rules.some((rule) => rule.kind === "applyPatch");
  }

  const command = getCommandApprovalPrefix(action);
  if (!command) return false;

  return rules.some(
    (rule) => rule.kind === "commandPrefix" && command.startsWith(rule.prefix),
  );
}

function getNextAutoApprovedAction(
  output: AgentChatOutput,
  rules: AgentApprovalAutoRule[] | undefined,
) {
  if (output.status !== "waiting_for_approval" || !rules?.length) return null;
  return (
    output.proposedActions.find((action) =>
      shouldAutoApproveAgentAction(action, rules),
    ) ?? null
  );
}

function SidebarToggleIcon({ open, side }: { open: boolean; side: Side }) {
  return (
    <span
      aria-hidden="true"
      className="panel-toggle__icon"
      data-open={open ? "true" : "false"}
      data-side={side}
    />
  );
}

type PendingMessageSave = {
  conversationId: string;
  message: ChatMessage;
};

type PendingMessagesUpsert = {
  conversationId: string;
  messages: ChatMessage[];
  positionOffset: number;
};

type MessagePersistenceMode = "none" | "throttled" | "immediate";

function stringifyComparable(value: unknown) {
  return JSON.stringify(value ?? null);
}

function hasConversationMetaChanged(previous: ChatConversation, next: ChatConversation) {
  if (previous.projectId !== next.projectId) return true;
  if (previous.modelId !== next.modelId) return true;
  if (previous.title !== next.title) return true;
  if (previous.createdAt !== next.createdAt) return true;
  if (previous.updatedAt !== next.updatedAt) return true;
  if ((previous.pinnedAt ?? null) !== (next.pinnedAt ?? null)) return true;
  if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
  if ((previous.unreadAt ?? null) !== (next.unreadAt ?? null)) return true;

  return false;
}

function hasExistingMessageStructureChanged(previous: ChatConversation, next: ChatConversation) {
  if (next.messages.length < previous.messages.length) return true;
  return previous.messages.some((message, index) => {
    const nextMessage = next.messages[index];
    return (
      !nextMessage ||
      message.id !== nextMessage.id ||
      message.role !== nextMessage.role ||
      message.createdAt !== nextMessage.createdAt
    );
  });
}

function hasNewMessageStructureIssue(previous: ChatConversation, next: ChatConversation) {
  return next.messages.slice(previous.messages.length).some((message) => {
    return (
      !message.id ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.createdAt !== "number"
    );
  });
}

function getImmediateAgentRunSignature(message: ChatMessage) {
  const run = message.agentRun;
  if (!run) return null;

  return {
    runId: run.runId,
    status: run.status,
    completedAt: run.completedAt ?? null,
    error: run.error ?? null,
    finishReason: run.finishReason ?? null,
    usage: run.usage ?? null,
    toolCalls: run.toolCalls,
    toolResults: run.toolResults,
    webSearchActivities: run.webSearchActivities ?? [],
    readActivities: run.readActivities ?? [],
    approvals: run.approvals,
    diffs: run.diffs,
    timeline: run.timeline.map((item) =>
      item.type === "message"
        ? {
            id: item.id,
            type: item.type,
          }
        : item,
    ),
  };
}

function getMessagePersistenceMode(previous: ChatMessage, next: ChatMessage): MessagePersistenceMode {
  const previousContent = previous.content;
  const nextContent = next.content;
  const previousAgentRun = stringifyComparable(previous.agentRun);
  const nextAgentRun = stringifyComparable(next.agentRun);
  const previousUiState = stringifyComparable(previous.uiState);
  const nextUiState = stringifyComparable(next.uiState);

  if (
    previousContent === nextContent &&
    previous.status === next.status &&
    previousAgentRun === nextAgentRun &&
    previousUiState === nextUiState
  ) {
    return "none";
  }

  if (previous.status !== next.status) return "immediate";
  if (previousUiState !== nextUiState) return "immediate";
  if (stringifyComparable(getImmediateAgentRunSignature(previous)) !== stringifyComparable(getImmediateAgentRunSignature(next))) {
    return "immediate";
  }

  return "throttled";
}

export function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const cancelledPendingMessageIdsRef = useRef<Set<string>>(new Set());
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());
  const approvalAutoRulesRef = useRef<Map<string, AgentApprovalAutoRule[]>>(new Map());
  const activeRunBindingsRef = useRef<Map<string, ActiveRunBinding>>(new Map());
  const bufferedAgentEventsRef = useRef<Map<string, AgentEvent[]>>(new Map());
  const previousPersistedConversationsRef = useRef<ChatConversation[]>([]);
  const conversationSaveQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const conversationMetaSaveQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const messagesUpsertQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const messageSaveQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const pendingMessageSaveTimersRef = useRef<Map<string, number>>(new Map());
  const pendingMessageSavePayloadsRef = useRef<Map<string, PendingMessageSave>>(new Map());
  const deletedConversationIdsRef = useRef<Set<string>>(new Set());
  const activeConversationIdRef = useRef<string | null>(null);
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
  const customPermissionsRef = useRef(uiPreferences.customPermissions);
  const [hasLoadedUiPreferences, setHasLoadedUiPreferences] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPageId>("general");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [newConversationProjectId, setNewConversationProjectId] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT_WIDTH);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT_WIDTH);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  customPermissionsRef.current = uiPreferences.customPermissions;

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

  const getConstrainedLayout = useCallback(
    (requestedLeftOpen: boolean, requestedRightOpen: boolean, preferredSide?: Side) => {
      const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth;
      let nextLeftOpen = requestedLeftOpen;
      let nextRightOpen = requestedRightOpen;
      let nextLeftWidth = clamp(leftWidth, LEFT_MIN_WIDTH, SIDE_MAX_WIDTH);
      let nextRightWidth = clamp(rightWidth, RIGHT_MIN_WIDTH, SIDE_MAX_WIDTH);

      const getMinimumOpenWidth = () =>
        CENTER_MIN_WIDTH +
        (nextLeftOpen ? LEFT_MIN_WIDTH : 0) +
        (nextRightOpen ? RIGHT_MIN_WIDTH : 0);

      if (shellWidth < getMinimumOpenWidth()) {
        if (preferredSide === "left") {
          nextRightOpen = false;
          if (shellWidth < getMinimumOpenWidth()) {
            nextLeftOpen = false;
          }
        } else if (preferredSide === "right") {
          nextLeftOpen = false;
          if (shellWidth < getMinimumOpenWidth()) {
            nextRightOpen = false;
          }
        } else {
          nextRightOpen = false;
          if (shellWidth < getMinimumOpenWidth()) {
            nextLeftOpen = false;
          }
        }
      }

      const maxOpenSideWidth = Math.max(0, shellWidth - CENTER_MIN_WIDTH);
      let overflow =
        (nextLeftOpen ? nextLeftWidth : 0) +
        (nextRightOpen ? nextRightWidth : 0) -
        maxOpenSideWidth;

      const shrinkLeft = () => {
        if (!nextLeftOpen || overflow <= 0) return;
        const shrinkAmount = Math.min(overflow, Math.max(0, nextLeftWidth - LEFT_MIN_WIDTH));
        nextLeftWidth -= shrinkAmount;
        overflow -= shrinkAmount;
      };
      const shrinkRight = () => {
        if (!nextRightOpen || overflow <= 0) return;
        const shrinkAmount = Math.min(overflow, Math.max(0, nextRightWidth - RIGHT_MIN_WIDTH));
        nextRightWidth -= shrinkAmount;
        overflow -= shrinkAmount;
      };

      if (overflow > 0) {
        const leftExcess = nextLeftOpen ? nextLeftWidth - LEFT_MIN_WIDTH : 0;
        const rightExcess = nextRightOpen ? nextRightWidth - RIGHT_MIN_WIDTH : 0;

        if (preferredSide === "left") {
          shrinkRight();
          shrinkLeft();
        } else if (preferredSide === "right") {
          shrinkLeft();
          shrinkRight();
        } else if (leftExcess >= rightExcess) {
          shrinkLeft();
          shrinkRight();
        } else {
          shrinkRight();
          shrinkLeft();
        }
      }

      return {
        leftOpen: nextLeftOpen,
        leftWidth: nextLeftWidth,
        rightOpen: nextRightOpen,
        rightWidth: nextRightWidth,
      };
    },
    [leftWidth, rightWidth],
  );

  const applyConstrainedLayout = useCallback(
    (requestedLeftOpen: boolean, requestedRightOpen: boolean, preferredSide?: Side) => {
      const nextLayout = getConstrainedLayout(requestedLeftOpen, requestedRightOpen, preferredSide);

      if (nextLayout.leftOpen !== leftOpen) {
        setLeftOpen(nextLayout.leftOpen);
      }
      if (nextLayout.rightOpen !== rightOpen) {
        setRightOpen(nextLayout.rightOpen);
      }
      if (Math.abs(nextLayout.leftWidth - leftWidth) > 0.5) {
        setLeftWidth(nextLayout.leftWidth);
      }
      if (Math.abs(nextLayout.rightWidth - rightWidth) > 0.5) {
        setRightWidth(nextLayout.rightWidth);
      }
    },
    [getConstrainedLayout, leftOpen, leftWidth, rightOpen, rightWidth],
  );

  const toggleLeftSidebar = useCallback(() => {
    const nextLeftOpen = !leftOpen;
    applyConstrainedLayout(nextLeftOpen, rightOpen, nextLeftOpen ? "left" : undefined);
  }, [applyConstrainedLayout, leftOpen, rightOpen]);

  const toggleRightSidebar = useCallback(() => {
    const nextRightOpen = !rightOpen;
    applyConstrainedLayout(leftOpen, nextRightOpen, nextRightOpen ? "right" : undefined);
  }, [applyConstrainedLayout, leftOpen, rightOpen]);

  useEffect(() => {
    const keepCenterVisible = () => {
      applyConstrainedLayout(leftOpen, rightOpen);
    };

    keepCenterVisible();
    window.addEventListener("resize", keepCenterVisible);
    return () => window.removeEventListener("resize", keepCenterVisible);
  }, [applyConstrainedLayout, leftOpen, rightOpen]);

  useEffect(() => {
    let isCancelled = false;

    void loadConversations()
      .then((storedConversations) => {
        if (!isCancelled) {
          previousPersistedConversationsRef.current = storedConversations;
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

  const enqueueConversationSave = useCallback((conversation: ChatConversation) => {
    deletedConversationIdsRef.current.delete(conversation.id);

    const previousSave = conversationSaveQueuesRef.current.get(conversation.id) ?? Promise.resolve();
    const nextSave = previousSave
      .catch(() => undefined)
      .then(async () => {
        if (deletedConversationIdsRef.current.has(conversation.id)) return;
        await saveConversation(conversation);
      })
      .catch((error) => {
        console.error("Failed to save conversation to SQLite", error);
      });

    conversationSaveQueuesRef.current.set(conversation.id, nextSave);
    void nextSave.finally(() => {
      if (conversationSaveQueuesRef.current.get(conversation.id) === nextSave) {
        conversationSaveQueuesRef.current.delete(conversation.id);
      }
    });
  }, []);

  const enqueueConversationMetaSave = useCallback((conversation: ChatConversation) => {
    deletedConversationIdsRef.current.delete(conversation.id);

    const previousMetaSave = conversationMetaSaveQueuesRef.current.get(conversation.id) ?? Promise.resolve();
    const pendingConversationSave =
      conversationSaveQueuesRef.current.get(conversation.id) ?? Promise.resolve();
    const nextSave = Promise.all([
      pendingConversationSave.catch(() => undefined),
      previousMetaSave.catch(() => undefined),
    ])
      .then(async () => {
        if (deletedConversationIdsRef.current.has(conversation.id)) return;
        await saveConversationMeta(conversation);
      })
      .catch((error) => {
        console.error("Failed to save conversation metadata to SQLite", error);
      });

    conversationMetaSaveQueuesRef.current.set(conversation.id, nextSave);
    void nextSave.finally(() => {
      if (conversationMetaSaveQueuesRef.current.get(conversation.id) === nextSave) {
        conversationMetaSaveQueuesRef.current.delete(conversation.id);
      }
    });
  }, []);

  const enqueueMessagesUpsert = useCallback((payload: PendingMessagesUpsert) => {
    if (payload.messages.length === 0) return;

    const previousUpsert = messagesUpsertQueuesRef.current.get(payload.conversationId) ?? Promise.resolve();
    const pendingConversationSave =
      conversationSaveQueuesRef.current.get(payload.conversationId) ?? Promise.resolve();
    const nextUpsert = Promise.all([
      pendingConversationSave.catch(() => undefined),
      previousUpsert.catch(() => undefined),
    ])
      .then(async () => {
        if (deletedConversationIdsRef.current.has(payload.conversationId)) return;
        await upsertChatMessages(payload.conversationId, payload.messages, payload.positionOffset);
      })
      .catch((error) => {
        console.error("Failed to upsert chat messages to SQLite", error);
      });

    messagesUpsertQueuesRef.current.set(payload.conversationId, nextUpsert);
    void nextUpsert.finally(() => {
      if (messagesUpsertQueuesRef.current.get(payload.conversationId) === nextUpsert) {
        messagesUpsertQueuesRef.current.delete(payload.conversationId);
      }
    });
  }, []);

  const enqueueMessageSaveNow = useCallback((payload: PendingMessageSave) => {
    const key = `${payload.conversationId}:${payload.message.id}`;
    const previousMessageSave = messageSaveQueuesRef.current.get(key) ?? Promise.resolve();
    const pendingConversationSave =
      conversationSaveQueuesRef.current.get(payload.conversationId) ?? Promise.resolve();
    const pendingMessagesUpsert =
      messagesUpsertQueuesRef.current.get(payload.conversationId) ?? Promise.resolve();

    const nextSave = Promise.all([
      pendingConversationSave.catch(() => undefined),
      pendingMessagesUpsert.catch(() => undefined),
      previousMessageSave.catch(() => undefined),
    ])
      .then(async () => {
        if (deletedConversationIdsRef.current.has(payload.conversationId)) return;
        await saveChatMessageState(payload.conversationId, payload.message);
      })
      .catch((error) => {
        console.error("Failed to save chat message state to SQLite", error);
      });

    messageSaveQueuesRef.current.set(key, nextSave);
    void nextSave.finally(() => {
      if (messageSaveQueuesRef.current.get(key) === nextSave) {
        messageSaveQueuesRef.current.delete(key);
      }
    });
  }, []);

  const enqueueMessageSave = useCallback(
    (payload: PendingMessageSave, mode: Exclude<MessagePersistenceMode, "none">) => {
      const key = `${payload.conversationId}:${payload.message.id}`;
      pendingMessageSavePayloadsRef.current.set(key, payload);

      if (mode === "immediate") {
        const existingTimer = pendingMessageSaveTimersRef.current.get(key);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
          pendingMessageSaveTimersRef.current.delete(key);
        }

        const latestPayload = pendingMessageSavePayloadsRef.current.get(key) ?? payload;
        pendingMessageSavePayloadsRef.current.delete(key);
        enqueueMessageSaveNow(latestPayload);
        return;
      }

      if (pendingMessageSaveTimersRef.current.has(key)) return;

      const timerId = window.setTimeout(() => {
        pendingMessageSaveTimersRef.current.delete(key);
        const latestPayload = pendingMessageSavePayloadsRef.current.get(key);
        pendingMessageSavePayloadsRef.current.delete(key);
        if (latestPayload) {
          enqueueMessageSaveNow(latestPayload);
        }
      }, STREAM_MESSAGE_SAVE_THROTTLE_MS);

      pendingMessageSaveTimersRef.current.set(key, timerId);
    },
    [enqueueMessageSaveNow],
  );

  useEffect(() => {
    if (!hasLoadedConversations) return;

    const previousById = new Map(
      previousPersistedConversationsRef.current.map((conversation) => [conversation.id, conversation]),
    );

    conversations.forEach((conversation) => {
      const previousConversation = previousById.get(conversation.id);

      if (!previousConversation) {
        enqueueConversationSave(conversation);
        return;
      }

      if (hasExistingMessageStructureChanged(previousConversation, conversation)) {
        enqueueConversationSave(conversation);
        return;
      }

      if (hasConversationMetaChanged(previousConversation, conversation)) {
        enqueueConversationMetaSave(conversation);
      }

      if (conversation.messages.length > previousConversation.messages.length) {
        if (hasNewMessageStructureIssue(previousConversation, conversation)) {
          enqueueConversationSave(conversation);
          return;
        }

        enqueueMessagesUpsert({
          conversationId: conversation.id,
          messages: conversation.messages.slice(previousConversation.messages.length),
          positionOffset: previousConversation.messages.length,
        });
      }

      conversation.messages.slice(0, previousConversation.messages.length).forEach((message, index) => {
        const previousMessage = previousConversation.messages[index];
        if (!previousMessage) return;

        const persistenceMode = getMessagePersistenceMode(previousMessage, message);
        if (persistenceMode === "none") return;

        enqueueMessageSave(
          {
            conversationId: conversation.id,
            message,
          },
          persistenceMode,
        );
      });
    });

    previousPersistedConversationsRef.current = conversations;
  }, [
    conversations,
    enqueueConversationSave,
    enqueueConversationMetaSave,
    enqueueMessageSave,
    enqueueMessagesUpsert,
    hasLoadedConversations,
  ]);

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
      deletedConversationIdsRef.current.add(conversationId);
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
      activeConversationIdRef.current = null;
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
  const hasUnreadConversations = conversations.some(
    (conversation) => !conversation.archivedAt && Boolean(conversation.unreadAt),
  );
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

  const cancelBackendAgentRun = useCallback((runId: string) => {
    void cancelAgentRun(runId).catch((error) => {
      console.error("Failed to cancel agent run", error);
    });
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
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setWorkspaceView("newConversation");
  }, []);

  const updateAssistantMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
      options: { touchConversation?: boolean } = {},
    ) => {
      const timestamp = Date.now();
      setConversations((currentConversations) =>
        currentConversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.id === messageId ? updater(message) : message,
                ),
                updatedAt: options.touchConversation ? timestamp : conversation.updatedAt,
              }
            : conversation,
        ),
      );
    },
    [],
  );

  const applyAgentOutputToMessage = useCallback(
    (conversationId: string, messageId: string, output: AgentChatOutput) => {
      updateAssistantMessage(
        conversationId,
        messageId,
        (message) => applyAgentOutputToChatMessage(message, output),
        { touchConversation: output.status !== "running" && output.status !== "idle" },
      );

      if (output.status !== "waiting_for_approval") {
        approvalAutoRulesRef.current.delete(messageId);
        cleanupRunBinding(output.runId);
      }
    },
    [cleanupRunBinding, updateAssistantMessage],
  );

  const updateMessageUiState = useCallback(
    (messageId: string, uiState: ChatMessageUiState | undefined) => {
      if (!activeConversationIdRef.current) return;

      const conversationId = activeConversationIdRef.current;
      setConversations((currentConversations) =>
        currentConversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.id === messageId
                    ? {
                        ...message,
                        uiState,
                      }
                    : message,
                ),
              }
            : conversation,
        ),
      );
    },
    [],
  );

  const applyAgentExecutionToMessage = useCallback(
    (conversationId: string, messageId: string, execution: AgentActionExecutionOutput) => {
      updateAssistantMessage(
        conversationId,
        messageId,
        (message) => applyAgentActionExecutionToChatMessage(message, execution),
        {
          touchConversation:
            execution.agentOutput.status !== "running" && execution.agentOutput.status !== "idle",
        },
      );

      if (execution.agentOutput.status !== "waiting_for_approval") {
        approvalAutoRulesRef.current.delete(messageId);
        cleanupRunBinding(execution.agentOutput.runId);
      }
    },
    [cleanupRunBinding, updateAssistantMessage],
  );

  const handleAgentEvent = useCallback(
    (conversationId: string, pendingMessageId: string, agentEvent: AgentEvent) => {
      if (agentEvent.runId && cancelledRunIdsRef.current.has(agentEvent.runId)) return;
      if (cancelledPendingMessageIdsRef.current.has(pendingMessageId)) return;

      updateAssistantMessage(
        conversationId,
        pendingMessageId,
        (message) => applyAgentEventToChatMessage(message, agentEvent),
        { touchConversation: shouldTouchConversationForAgentEvent(agentEvent) },
      );

      if (agentEvent.type === "done") {
        if (agentEvent.status !== "waiting_for_approval") {
          approvalAutoRulesRef.current.delete(pendingMessageId);
        }

        if (agentEvent.success && agentEvent.status !== "waiting_for_approval") {
          const completedAt = Date.now();
          setConversations((currentConversations) =>
            currentConversations.map((conversation) =>
              conversation.id === conversationId && activeConversationIdRef.current !== conversationId
                ? {
                    ...conversation,
                    unreadAt: completedAt,
                  }
                : conversation,
            ),
          );
        }

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
      if (cancelledRunIdsRef.current.has(agentEvent.runId)) return;

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
      permissionMode: ChatPermissionMode,
      attachments: AgentInputAttachment[] | undefined,
      title?: string,
    ) => {
      const input: AgentConversationTurnInput = {
        assistantMessageId: pendingMessageId,
        content,
        conversationId,
        maxTokens: DEFAULT_AGENT_MAX_TOKENS,
        modelId,
        permissions: resolveChatPermissions(permissionMode, customPermissionsRef.current),
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
          cancelledRunIdsRef.current.add(startOutput.runId);
          cancelBackendAgentRun(startOutput.runId);
          bufferedAgentEventsRef.current.delete(startOutput.runId);
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
                  updatedAt: conversation.updatedAt,
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
          if (activeConversationIdRef.current === conversationId) {
            activeConversationIdRef.current = resolvedConversationId;
          }
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

        updateAssistantMessage(
          conversationId,
          pendingMessageId,
          (message) => ({
            ...message,
            content: getErrorMessage(error),
            status: "error",
            agentRun: {
              ...ensureAgentRun(message.agentRun, null, "failed"),
              error: getErrorMessage(error),
            },
          }),
          { touchConversation: true },
        );
      }
    },
    [cancelBackendAgentRun, handleAgentEvent, updateAssistantMessage],
  );

  const createConversationFromMessage = useCallback(
    (content: string, options: ChatSubmitOptions) => {
      approvalAutoRulesRef.current.clear();
      const now = Date.now();
      const title = createConversationTitle(content);
      const userMessage = createUserMessage(content, options.attachments);
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
        unreadAt: null,
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
      activeConversationIdRef.current = conversation.id;
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
        options.permissionMode,
        options.attachments,
        title,
      );
    },
    [requestAssistantResponse],
  );

  const appendMessageToActiveConversation = useCallback(
    (content: string, options: ChatSubmitOptions) => {
      approvalAutoRulesRef.current.clear();
      if (!activeConversationId) {
        createConversationFromMessage(content, options);
        return;
      }

      const activeConversationSnapshot = conversations.find((conversation) => conversation.id === activeConversationId);
      if (!activeConversationSnapshot) {
        createConversationFromMessage(content, options);
        return;
      }

      const userMessage = createUserMessage(content, options.attachments);
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
        options.permissionMode,
        options.attachments,
      );
    },
    [activeConversationId, conversations, createConversationFromMessage, requestAssistantResponse],
  );

  const selectConversation = useCallback((conversationId: string) => {
    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.id === conversationId && conversation.unreadAt
          ? {
              ...conversation,
              unreadAt: null,
            }
          : conversation,
      ),
    );
    activeConversationIdRef.current = conversationId;
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

  const renameConversation = useCallback((conversationId: string, title: string) => {
    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title,
            }
          : conversation,
      ),
    );
  }, []);

  const markConversationUnread = useCallback(
    (conversationId: string) => {
      if (conversationId === activeConversationIdRef.current) return;

      const now = Date.now();
      setConversations((currentConversations) =>
        currentConversations.map((conversation) => {
          if (conversation.id !== conversationId || conversation.unreadAt) return conversation;

          const isPending = conversation.messages.some(
            (message) => message.role === "assistant" && message.status === "pending",
          );
          if (isPending) return conversation;

          return {
            ...conversation,
            unreadAt: now,
          };
        }),
      );
    },
    [],
  );

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
        activeConversationIdRef.current = null;
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
        activeConversationIdRef.current = null;
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
      activeConversationIdRef.current = null;
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
      activeConversationIdRef.current = null;
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
      deletedConversationIdsRef.current.add(conversationId);
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
        activeConversationIdRef.current = null;
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

    archivedConversationIds.forEach((conversationId) => {
      deletedConversationIdsRef.current.add(conversationId);
    });

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
      activeConversationIdRef.current = null;
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
    const stoppedAt = Date.now();

    const activeConversationSnapshot = conversations.find((conversation) => conversation.id === activeConversationId);
    const pendingMessage = [...(activeConversationSnapshot?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "pending");

    if (!pendingMessage) return;

    approvalAutoRulesRef.current.delete(pendingMessage.id);
    cancelledPendingMessageIdsRef.current.add(pendingMessage.id);

    if (pendingMessage.agentRun?.runId) {
      cancelledRunIdsRef.current.add(pendingMessage.agentRun.runId);
      cancelBackendAgentRun(pendingMessage.agentRun.runId);
      cleanupRunBinding(pendingMessage.agentRun.runId);
    }

    setConversations((currentConversations) =>
      currentConversations.map((conversation) =>
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === pendingMessage.id
                  ? (() => {
                      const currentRun = ensureAgentRun(
                        message.agentRun,
                        pendingMessage.agentRun?.runId ?? null,
                        "cancelled",
                      );
                      const startedAt = message.agentRun?.startedAt ?? message.createdAt;
                      const visibleContent =
                        message.content && message.content !== THINKING_PLACEHOLDER ? message.content : "";

                      return {
                        ...message,
                        content: visibleContent,
                        status: "sent",
                        agentRun: {
                          ...currentRun,
                          status: "cancelled",
                          startedAt,
                          completedAt: stoppedAt,
                          webSearchActivities: cancelPendingWebSearchActivities(currentRun, stoppedAt),
                          readActivities: cancelPendingReadActivities(currentRun, stoppedAt),
                        },
                      };
                    })()
                  : message,
              ),
              updatedAt: stoppedAt,
            }
          : conversation,
      ),
    );
  }, [activeConversationId, cancelBackendAgentRun, cleanupRunBinding, conversations]);

  const handleApproveAgentAction = useCallback(
    async (
      messageId: string,
      action: AgentProposedAction,
      options: AgentApprovalOptions = {},
    ) => {
      if (!activeConversationId) return;
      const conversationId = activeConversationId;
      const rememberedPrefix = options.rememberForRun ? getCommandApprovalPrefix(action) : "";
      const rememberPatchesForRun = options.rememberForRun && action.type === "diff";

      if (rememberedPrefix) {
        const currentRules = approvalAutoRulesRef.current.get(messageId) ?? [];
        if (
          !currentRules.some(
            (rule) => rule.kind === "commandPrefix" && rule.prefix === rememberedPrefix,
          )
        ) {
          approvalAutoRulesRef.current.set(messageId, [
            ...currentRules,
            {
              kind: "commandPrefix",
              prefix: rememberedPrefix,
            },
          ]);
        }
      }
      if (rememberPatchesForRun) {
        const currentRules = approvalAutoRulesRef.current.get(messageId) ?? [];
        if (!currentRules.some((rule) => rule.kind === "applyPatch")) {
          approvalAutoRulesRef.current.set(messageId, [...currentRules, { kind: "applyPatch" }]);
        }
      }

      try {
        let actionToApprove: AgentProposedAction | null = action;
        let approvalSteps = 0;

        while (actionToApprove && approvalSteps < AUTO_APPROVAL_MAX_STEPS) {
          approvalSteps += 1;
          const currentAction = actionToApprove;

          updateAssistantMessage(
            conversationId,
            messageId,
            (message) => applyAgentActionDecisionToChatMessage(message, currentAction, "approved"),
            { touchConversation: true },
          );

          const execution = await approveAgentAction(getAgentActionId(currentAction));
          applyAgentExecutionToMessage(conversationId, messageId, execution);

          actionToApprove = getNextAutoApprovedAction(
            execution.agentOutput,
            approvalAutoRulesRef.current.get(messageId),
          );
        }

        if (approvalSteps >= AUTO_APPROVAL_MAX_STEPS) {
          console.warn("Stopped automatic approvals after reaching the local safety limit.");
        }
      } catch (error) {
        approvalAutoRulesRef.current.delete(messageId);
        updateAssistantMessage(
          conversationId,
          messageId,
          (message) => {
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
          },
          { touchConversation: true },
        );
      }
    },
    [activeConversationId, applyAgentExecutionToMessage, updateAssistantMessage],
  );

  const handleRejectAgentAction = useCallback(
    async (messageId: string, action: AgentProposedAction, message?: string) => {
      if (!activeConversationId) return;
      const conversationId = activeConversationId;
      approvalAutoRulesRef.current.delete(messageId);

      try {
        updateAssistantMessage(
          conversationId,
          messageId,
          (currentMessage) =>
            applyAgentActionDecisionToChatMessage(currentMessage, action, "rejected", message),
          { touchConversation: true },
        );

        const execution = await rejectAgentAction(getAgentActionId(action), message);
        applyAgentExecutionToMessage(conversationId, messageId, execution);
      } catch (error) {
        updateAssistantMessage(
          conversationId,
          messageId,
          (message) => {
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
          },
          { touchConversation: true },
        );
      }
    },
    [activeConversationId, applyAgentExecutionToMessage, updateAssistantMessage],
  );

  const handleCancelAgentAction = useCallback(
    async (messageId: string, action: AgentProposedAction) => {
      if (!activeConversationId) return;
      const conversationId = activeConversationId;
      approvalAutoRulesRef.current.delete(messageId);

      try {
        await cancelAgentAction(getAgentActionId(action));
        updateAssistantMessage(
          conversationId,
          messageId,
          (message) => {
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
          },
          { touchConversation: true },
        );
      } catch (error) {
        updateAssistantMessage(
          conversationId,
          messageId,
          (message) => {
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
          },
          { touchConversation: true },
        );
      }
    },
    [activeConversationId, updateAssistantMessage],
  );

  if (view === "settings") {
    return (
      <SettingsPage
        conversations={conversations}
        projects={projects}
        initialPage={settingsInitialPage}
        onBack={() => setView("workspace")}
        onDeleteAllArchivedConversations={deleteArchivedConversations}
        onDeleteConversation={deleteConversation}
        onUnarchiveConversation={unarchiveConversation}
        onUiPreferencesChange={updateUiPreferences}
        uiPreferences={uiPreferences}
      />
    );
  }

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-left-open={leftOpen}
      data-native-font-smoothing={
        SUPPORTS_NATIVE_FONT_SMOOTHING && uiPreferences.nativeFontSmoothing ? "true" : undefined
      }
      data-right-open={rightOpen}
      data-translucent-sidebar={uiPreferences.translucentSidebar || undefined}
      style={{
        "--left-panel-width": `${leftOpen ? leftWidth : 0}px`,
        "--right-panel-width": `${rightOpen ? rightWidth : 0}px`,
      } as React.CSSProperties}
    >
      <header className="window-toolbar" data-tauri-drag-region />

      <div className="side-panel side-panel--left">
        <LeftSidebar
          activeConversationId={activeConversationId}
          conversations={conversations}
          projects={projects}
          uiPreferences={uiPreferences}
          onArchiveAllProjectConversations={archiveAllProjectConversations}
          onArchiveAllRootConversations={archiveAllRootConversations}
          onArchiveConversation={archiveConversation}
          onArchiveProjectConversations={archiveProjectConversations}
          onMarkConversationUnread={markConversationUnread}
          onNewConversation={startNewConversation}
          onOpenSettings={(page: SettingsPageId = "general") => {
            setSettingsInitialPage(page);
            setView("settings");
          }}
          onRemoveProject={deleteProject}
          onRenameConversation={renameConversation}
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
            data-has-unread={!leftOpen && hasUnreadConversations ? "true" : undefined}
            type="button"
            aria-label={leftOpen ? t("app.collapseLeftSidebar") : t("app.expandLeftSidebar")}
            aria-pressed={leftOpen}
            onClick={toggleLeftSidebar}
          >
            <SidebarToggleIcon open={leftOpen} side="left" />
          </button>

          <button
            className="panel-toggle panel-toggle--right"
            type="button"
            aria-label={rightOpen ? t("app.collapseRightSidebar") : t("app.expandRightSidebar")}
            aria-pressed={rightOpen}
            onClick={toggleRightSidebar}
          >
            <SidebarToggleIcon open={rightOpen} side="right" />
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
              permissionModeAvailability={{
                custom: uiPreferences.customPermissionEnabled,
                full: uiPreferences.fullPermissionEnabled,
              }}
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
              onMessageUiStateChange={updateMessageUiState}
              onStopGenerating={stopActiveGeneration}
              onSubmitMessage={appendMessageToActiveConversation}
              permissionModeAvailability={{
                custom: uiPreferences.customPermissionEnabled,
                full: uiPreferences.fullPermissionEnabled,
              }}
              showTokenUsageDetails={uiPreferences.showTokenUsageDetails}
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
