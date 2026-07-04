import type {
  AgentActionExecutionOutput,
  AgentChatOutput,
  AgentCommandExecutionResult,
  AgentEvent,
  AgentProposedAction,
} from "@agent";
import type {
  ChatAgentCommandOutput,
  ChatAgentRunView,
  ChatAgentTimelineItem,
  ChatMessage,
} from "../features/chat/chatTypes";
import { THINKING_PLACEHOLDER } from "./appConstants";
import { getAgentActionId } from "./agentActionUtils";
import {
  normalizeReadActivities,
  upsertReadActivityFromCall,
  upsertReadActivityFromResult,
} from "../features/chat/agentReadActivities";
import {
  normalizeWebSearchActivities,
  upsertWebSearchActivityFromCall,
  upsertWebSearchActivityFromResult,
} from "../features/chat/agentWebSearch";

function createAgentRun(
  runId: string | null,
  status: ChatAgentRunView["status"] = "starting",
): ChatAgentRunView {
  const now = Date.now();

  return {
    runId,
    status,
    startedAt: now,
    completedAt: isCompletedAgentRunStatus(status) ? now : undefined,
    toolDefinitions: [],
    toolCalls: [],
    toolResults: [],
    approvals: [],
    diffs: [],
    commandOutputs: [],
    webSearchActivities: [],
    readActivities: [],
    timeline: [],
  };
}

export function ensureAgentRun(
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
    startedAt: currentRun.startedAt ?? Date.now(),
    completedAt: isCompletedAgentRunStatus(status) ? currentRun.completedAt ?? Date.now() : currentRun.completedAt,
    timeline: currentRun.timeline ?? [],
    readActivities: currentRun.readActivities ?? [],
  };
}

function isCompletedAgentRunStatus(status: ChatAgentRunView["status"] | undefined) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isFinishedAgentOutputStatus(status: ChatAgentRunView["status"] | undefined) {
  return status !== "starting" && status !== "running" && status !== "waiting_for_approval";
}

function upsertById<T>(items: T[], nextItem: T, getId: (item: T) => string) {
  const nextId = getId(nextItem);
  const itemIndex = items.findIndex((item) => getId(item) === nextId);

  if (itemIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item, index) => (index === itemIndex ? nextItem : item));
}

function upsertAgentAction(actions: AgentProposedAction[], nextAction: AgentProposedAction) {
  return upsertById(actions, nextAction, getAgentActionId);
}

export function appendTimelineItem(
  run: ChatAgentRunView,
  item: ChatAgentTimelineItem,
): ChatAgentTimelineItem[] {
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

function appendMessageDeltaToTimeline(
  run: ChatAgentRunView,
  delta: string,
): ChatAgentTimelineItem[] {
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

function getRunResponseTimestamps(run: ChatAgentRunView, receivedAt: number) {
  return {
    firstResponseAt: run.firstResponseAt ?? receivedAt,
    lastResponseAt: receivedAt,
  };
}

export function shouldTouchConversationForAgentEvent(agentEvent: AgentEvent) {
  if (agentEvent.type === "done") return true;
  if (agentEvent.type === "approval_required") return true;
  if (agentEvent.type === "error" && !agentEvent.recoverable) return true;

  if (agentEvent.type === "state") {
    return ["waiting_for_approval", "completed", "failed", "cancelled"].includes(agentEvent.state.status);
  }

  return false;
}

function getChatMessageStatusFromAgentStatus(status: AgentChatOutput["status"]): ChatMessage["status"] {
  if (status === "running" || status === "waiting_for_approval") return "pending";
  if (status === "failed") return "error";
  return "sent";
}

export function applyAgentEventToChatMessage(message: ChatMessage, agentEvent: AgentEvent): ChatMessage {
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
        startedAt: currentRun.startedAt ?? Date.now(),
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
        completedAt: isCompletedAgentRunStatus(agentEvent.state.status)
          ? currentRun.completedAt ?? Date.now()
          : currentRun.completedAt,
        state: agentEvent.state,
        error: agentEvent.state.lastError ?? currentRun.error,
      },
    };
  }

  if (agentEvent.type === "message_delta") {
    const receivedAt = Date.now();

    return {
      ...message,
      content: getMessageContentAfterDelta(message.content, agentEvent.delta),
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        ...getRunResponseTimestamps(currentRun, receivedAt),
        timeline: appendMessageDeltaToTimeline(currentRun, agentEvent.delta),
      },
    };
  }

  if (agentEvent.type === "message") {
    const receivedAt = Date.now();

    return {
      ...message,
      content: agentEvent.content,
      status: "pending",
      agentRun: {
        ...currentRun,
        status: "running",
        ...getRunResponseTimestamps(currentRun, receivedAt),
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
        webSearchActivities: upsertWebSearchActivityFromCall(currentRun, agentEvent.call),
        readActivities: upsertReadActivityFromCall(currentRun, agentEvent.call),
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
        webSearchActivities: upsertWebSearchActivityFromResult(currentRun, agentEvent.result),
        readActivities: upsertReadActivityFromResult(currentRun, agentEvent.result),
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
        completedAt: agentEvent.recoverable ? currentRun.completedAt : currentRun.completedAt ?? Date.now(),
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
  const completedAt = isFinishedAgentOutputStatus(nextStatus)
    ? currentRun.completedAt ?? Date.now()
    : currentRun.completedAt;
  const finalResponseAt =
    agentEvent.content && !currentRun.firstResponseAt ? completedAt ?? Date.now() : currentRun.firstResponseAt;

  return {
    ...message,
    content: getFinalMessageContent(message.content, agentEvent.content),
    status:
      nextStatus === "waiting_for_approval"
        ? "pending"
        : nextStatus === "cancelled" || agentEvent.success
          ? "sent"
          : "error",
    agentRun: {
      ...currentRun,
      status: nextStatus,
      firstResponseAt: finalResponseAt,
      lastResponseAt: agentEvent.content ? currentRun.lastResponseAt ?? finalResponseAt : currentRun.lastResponseAt,
      completedAt,
      usage: agentEvent.usage,
      finishReason: agentEvent.finishReason,
      approvals: proposedActions.reduce(upsertAgentAction, currentRun.approvals),
      timeline: appendApprovalActionsToTimeline(currentRun.timeline, proposedActions),
    },
  };
}

export function applyAgentOutputToChatMessage(message: ChatMessage, output: AgentChatOutput): ChatMessage {
  const streamedContentEvents = output.events.some(
    (event) => event.type === "message" || event.type === "message_delta",
  );
  const messageWithEvents = output.events.reduce(applyAgentEventToChatMessage, message);
  const currentRun = ensureAgentRun(messageWithEvents.agentRun, output.runId, output.status);
  const nextContent =
    output.content && (!streamedContentEvents || !messageWithEvents.content || messageWithEvents.content === THINKING_PLACEHOLDER)
      ? output.content
      : messageWithEvents.content;
  const outputCompletedAt = isFinishedAgentOutputStatus(output.status)
    ? currentRun.completedAt ?? Date.now()
    : currentRun.completedAt;
  const finalResponseAt =
    nextContent && nextContent !== THINKING_PLACEHOLDER && !currentRun.firstResponseAt
      ? outputCompletedAt ?? Date.now()
      : currentRun.firstResponseAt;

  return {
    ...messageWithEvents,
    content: nextContent,
    status: getChatMessageStatusFromAgentStatus(output.status),
    agentRun: {
      ...currentRun,
      status: output.status,
      firstResponseAt: finalResponseAt,
      lastResponseAt: finalResponseAt && !currentRun.lastResponseAt ? finalResponseAt : currentRun.lastResponseAt,
      completedAt: outputCompletedAt,
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

export function applyAgentActionExecutionToChatMessage(
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
      webSearchActivities: normalizeWebSearchActivities(currentRun),
      readActivities: normalizeReadActivities(currentRun),
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
