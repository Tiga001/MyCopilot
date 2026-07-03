import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Check,
  Copy,
  PencilLine,
  SquareTerminal,
} from "lucide-react";
import type { AgentProposedAction } from "@agent";
import type {
  ChatAgentRunView,
  ChatAgentTimelineItem,
  ChatMessage,
} from "../chatTypes";
import { getUniqueWebSearchSources } from "../agentWebSearch";
import {
  getAttachmentBadgeLabel,
  getAttachmentExtension,
  getAttachmentIcon,
  getAttachmentPreviewUrl,
} from "../attachmentDisplay";
import { ChatMarkdown } from "./ChatMarkdown";
import { AgentToolActivity } from "./toolActivities/AgentToolActivity";
import { AssistantSources } from "./toolActivities/WebSearchSources";
import { formatToolDetails, getToolDisplayName } from "./toolActivities/toolActivityUtils";

const ACTIVE_STREAMING_GRACE_MS = 1200;
const COPIED_INDICATOR_MS = 1300;

interface ChatMessageItemProps {
  isLastAssistantMessage?: boolean;
  message: ChatMessage;
  onApprove?: (messageId: string, action: AgentProposedAction) => void;
  onCancel?: (messageId: string, action: AgentProposedAction) => void;
  onReject?: (messageId: string, action: AgentProposedAction) => void;
  onUiStateChange?: (messageId: string, uiState: ChatMessage["uiState"]) => void;
}

function formatMessageTime(timestamp: number | undefined) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const time = `${date.getHours()}:${date.getMinutes().toString().padStart(2, "0")}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const messageDay = new Date(date);
  messageDay.setHours(0, 0, 0, 0);

  const dayDistance = Math.floor((today.getTime() - messageDay.getTime()) / 86_400_000);
  if (dayDistance <= 0) return time;
  if (dayDistance === 1) return `昨天 ${time}`;
  if (dayDistance <= 7) {
    return `${new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(date)} ${time}`;
  }

  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

async function copyTextToClipboard(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function getToolResult(run: ChatAgentRunView, callId: string) {
  return run.toolResults.find((result) => result.callId === callId);
}

function getActionId(action: AgentProposedAction) {
  if (action.type === "diff") return action.diff.id;
  if (action.type === "command") return action.command.id;
  return action.call.id;
}

function getActionById(run: ChatAgentRunView, actionId: string) {
  return run.approvals.find((action) => getActionId(action) === actionId);
}

function isRunSettled(run: ChatAgentRunView) {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    (run.status === "idle" && Boolean(run.completedAt))
  );
}

function isTokenLimitFinishReason(finishReason: string | undefined) {
  if (!finishReason) return false;
  const normalized = finishReason.toLowerCase();
  return (
    normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized.includes("max_token")
  );
}

function isThinkingPlaceholder(content: string) {
  return content.trim() === "正在思考...";
}

function hasDisplayableContent(content: string) {
  return Boolean(content.trim()) && !isThinkingPlaceholder(content);
}

function isPendingApprovalStatus(status?: string) {
  return status === "required" || status === "not_required";
}

function isTimelineItemRenderable(run: ChatAgentRunView, item: ChatAgentTimelineItem) {
  if (item.type === "message") return Boolean(item.content.trim());
  if (item.type === "tool_call") return run.toolCalls.some((candidate) => candidate.id === item.callId);
  if (item.type === "diff") return run.diffs.some((candidate) => candidate.id === item.diffId);
  if (item.type === "approval") return Boolean(getActionById(run, item.actionId));
  if (item.type === "command_output") {
    return run.commandOutputs.some((candidate) => candidate.id === item.outputId);
  }
  return true;
}

function getLastRenderableTimelineItem(run: ChatAgentRunView, timeline: ChatAgentTimelineItem[]) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (isTimelineItemRenderable(run, item)) {
      return item;
    }
  }

  return undefined;
}

function getLastMessageTimelineContent(timeline: ChatAgentTimelineItem[]) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.type === "message" && hasDisplayableContent(item.content)) {
      return item.content;
    }
  }

  return "";
}

function getAssistantFinalContent(message: ChatMessage) {
  const timelineContent = getLastMessageTimelineContent(message.agentRun?.timeline ?? []);
  const content = timelineContent || message.content;
  return isThinkingPlaceholder(content) ? "" : content;
}

function getAttachmentSummary(attachments: NonNullable<ChatMessage["attachments"]>) {
  return `附件：${attachments.map((attachment) => attachment.name).join("、")}`;
}

function getUserVisibleContent(message: ChatMessage) {
  if (message.role !== "user" || !message.attachments?.length) return message.content;

  const summary = getAttachmentSummary(message.attachments);
  if (message.content === summary) return "";

  const suffix = `\n\n${summary}`;
  if (message.content.endsWith(suffix)) {
    return message.content.slice(0, -suffix.length);
  }

  return message.content;
}

function isBottomTimelineItemSpecificPendingStatus(
  run: ChatAgentRunView,
  item: ChatAgentTimelineItem | undefined,
) {
  if (!item) return false;

  if (item.type === "tool_call") {
    return !getToolResult(run, item.callId);
  }

  if (item.type === "diff") {
    const diff = run.diffs.find((candidate) => candidate.id === item.diffId);
    return Boolean(diff && isPendingApprovalStatus(diff.approvalStatus));
  }

  if (item.type === "approval") {
    const action = getActionById(run, item.actionId);
    if (!action) return false;
    if (action.type === "diff") return isPendingApprovalStatus(action.diff.approvalStatus);
    if (action.type === "command") return isPendingApprovalStatus(action.command.approvalStatus);
    return isPendingApprovalStatus(action.call.approvalStatus);
  }

  return false;
}

function shouldShowThinkingActivity(run: ChatAgentRunView, timeline: ChatAgentTimelineItem[]) {
  if (isRunSettled(run)) return false;

  const lastItem = getLastRenderableTimelineItem(run, timeline);
  return !isBottomTimelineItemSpecificPendingStatus(run, lastItem);
}

function hasCollapsibleTimelineContent(run: ChatAgentRunView, timeline: ChatAgentTimelineItem[]) {
  return timeline.some((item) => item.type !== "message" && isTimelineItemRenderable(run, item));
}

function shouldShowAssistantActions(message: ChatMessage) {
  if (message.role !== "assistant" || message.status !== "sent") return false;
  if (!getAssistantFinalContent(message).trim()) return false;
  return !message.agentRun || message.agentRun.status === "completed" || message.agentRun.status === "idle";
}

function formatElapsedDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function AgentRunElapsedHeader({
  canToggle,
  collapsed,
  isThinking,
  label,
  onToggle,
}: {
  canToggle: boolean;
  collapsed: boolean;
  isThinking: boolean;
  label: string;
  onToggle: () => void;
}) {
  const content = (
    <>
      <span className={isThinking ? "agent-running-text" : undefined}>{label}</span>
      {canToggle && (
        <ChevronDown
          aria-hidden="true"
          className="agent-run__elapsed-chevron"
          data-collapsed={collapsed ? "true" : "false"}
        />
      )}
    </>
  );

  if (!canToggle) {
    return <div className="agent-run__elapsed">{content}</div>;
  }

  return (
    <button
      aria-expanded={!collapsed}
      className="agent-run__elapsed agent-run__elapsed-button"
      onClick={onToggle}
      type="button"
    >
      {content}
    </button>
  );
}

function ChatMessageActions({ content, timestamp }: { content: string; timestamp: number | undefined }) {
  const [copied, setCopied] = useState(false);
  const timeLabel = formatMessageTime(timestamp);
  const canCopy = Boolean(content.trim());
  const Icon = copied ? Check : Copy;

  useEffect(() => {
    if (!copied) return undefined;

    const timerId = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_INDICATOR_MS);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [copied]);

  return (
    <div className="chat-message__actions" aria-label="消息操作">
      {timeLabel && <time dateTime={new Date(timestamp ?? 0).toISOString()}>{timeLabel}</time>}
      <button
        aria-label={copied ? "已复制" : "复制消息"}
        disabled={!canCopy}
        onClick={() => {
          if (!canCopy) return;
          void copyTextToClipboard(content)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        title={copied ? "已复制" : "复制消息"}
        type="button"
      >
        <Icon aria-hidden="true" />
        <span className="chat-message__action-tooltip" role="tooltip">
          {copied ? "已复制" : "复制"}
        </span>
      </button>
    </div>
  );
}

function AgentDiffActivity({ run, diffId }: { run: ChatAgentRunView; diffId: string }) {
  const diff = run.diffs.find((candidate) => candidate.id === diffId);
  if (!diff) return null;
  const isPending = isPendingApprovalStatus(diff.approvalStatus);

  return (
    <details className="agent-activity agent-activity--diff">
      <summary>
        <PencilLine aria-hidden="true" />
        <span className={isPending ? "agent-running-text" : undefined}>
          {diff.approvalStatus === "approved" ? "已编辑" : "正在编辑"} {diff.filePath}
        </span>
        <ChevronDown className="agent-activity__chevron" aria-hidden="true" />
      </summary>
      <div className="agent-activity__details">
        {diff.summary && <p>{diff.summary}</p>}
        <pre>{diff.patch}</pre>
      </div>
    </details>
  );
}

function getApprovalTitle(action: AgentProposedAction) {
  if (action.type === "diff") return `需要审批编辑 ${action.diff.filePath}`;
  if (action.type === "command") return `需要审批命令：${action.command.command}`;
  return `需要审批工具：${getToolDisplayName(action.call.tool)}`;
}

function getApprovalDetails(action: AgentProposedAction) {
  if (action.type === "diff") return action.diff.summary ?? action.diff.patch;
  if (action.type === "command") return action.command.reason ?? action.command.cwd ?? "";
  return action.call.reason ?? formatToolDetails(action.call.args);
}

function AgentApprovalActivity({
  action,
  messageId,
  onApprove,
  onCancel,
  onReject,
}: {
  action: AgentProposedAction;
  messageId: string;
  onApprove?: (messageId: string, action: AgentProposedAction) => void;
  onCancel?: (messageId: string, action: AgentProposedAction) => void;
  onReject?: (messageId: string, action: AgentProposedAction) => void;
}) {
  return (
    <div className="agent-approval-card">
      <div className="agent-approval-card__body">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>{getApprovalTitle(action)}</strong>
          {getApprovalDetails(action) && <p>{getApprovalDetails(action)}</p>}
        </div>
      </div>
      <div className="agent-approval-card__actions">
        <button type="button" onClick={() => onReject?.(messageId, action)}>
          拒绝
        </button>
        <button type="button" onClick={() => onCancel?.(messageId, action)}>
          取消
        </button>
        <button type="button" data-variant="primary" onClick={() => onApprove?.(messageId, action)}>
          批准
        </button>
      </div>
    </div>
  );
}

function AgentCommandOutputActivity({ run, outputId }: { run: ChatAgentRunView; outputId: string }) {
  const output = run.commandOutputs.find((candidate) => candidate.id === outputId);
  if (!output) return null;

  return (
    <details className="agent-activity">
      <summary>
        <SquareTerminal aria-hidden="true" />
        <span>
          {output.stream === "stderr" ? "命令错误" : "命令输出"}：{output.command}
        </span>
        <ChevronDown className="agent-activity__chevron" aria-hidden="true" />
      </summary>
      <div className="agent-activity__details">
        <pre>{output.output}</pre>
      </div>
    </details>
  );
}

function AgentThinkingActivity() {
  return (
    <div className="agent-thinking">
      <span className="agent-running-text">正在思考</span>
    </div>
  );
}

function AgentTimelineItemView({
  item,
  message,
  onApprove,
  onCancel,
  onReject,
  run,
}: {
  item: ChatAgentTimelineItem;
  message: ChatMessage;
  onApprove?: (messageId: string, action: AgentProposedAction) => void;
  onCancel?: (messageId: string, action: AgentProposedAction) => void;
  onReject?: (messageId: string, action: AgentProposedAction) => void;
  run: ChatAgentRunView;
}) {
  if (item.type === "message") {
    if (!item.content.trim()) return null;
    return <ChatMarkdown className="chat-agent-text" content={item.content} />;
  }

  if (item.type === "tool_call") {
    const call = run.toolCalls.find((candidate) => candidate.id === item.callId);
    if (!call) return null;
    const activity = run.webSearchActivities?.find((candidate) => candidate.callId === call.id);
    return <AgentToolActivity activity={activity} call={call} result={getToolResult(run, call.id)} />;
  }

  if (item.type === "diff") {
    return <AgentDiffActivity diffId={item.diffId} run={run} />;
  }

  if (item.type === "approval") {
    const action = getActionById(run, item.actionId);
    if (!action) return null;

    return (
      <AgentApprovalActivity
        action={action}
        messageId={message.id}
        onApprove={onApprove}
        onCancel={onCancel}
        onReject={onReject}
      />
    );
  }

  if (item.type === "command_output") {
    return <AgentCommandOutputActivity outputId={item.outputId} run={run} />;
  }

  return (
    <div className="agent-activity agent-activity--error">
      <AlertTriangle aria-hidden="true" />
      <span>{item.message}</span>
    </div>
  );
}

function AgentRunView({
  message,
  onApprove,
  onCancel,
  onReject,
  onUiStateChange,
}: {
  message: ChatMessage;
  onApprove?: (messageId: string, action: AgentProposedAction) => void;
  onCancel?: (messageId: string, action: AgentProposedAction) => void;
  onReject?: (messageId: string, action: AgentProposedAction) => void;
  onUiStateChange?: (messageId: string, uiState: ChatMessage["uiState"]) => void;
}) {
  const run = message.agentRun;
  const timeline = run?.timeline ?? [];
  const hasTimeline = timeline.length > 0;
  const hasTimelineError = timeline.some((item) => item.type === "error");
  const canToggleTimeline = Boolean(run && isRunSettled(run) && hasCollapsibleTimelineContent(run, timeline));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!run || isRunSettled(run)) return undefined;

    const timerId = window.setInterval(() => {
      setNow(Date.now());
    }, 500);

    return () => {
      window.clearInterval(timerId);
    };
  }, [run?.runId, run?.status]);

  const headerState = useMemo(() => {
    const hasFirstResponse = Boolean(run?.firstResponseAt);

    if (run && !hasFirstResponse && !isRunSettled(run)) {
      return {
        isThinking: true,
        label: "正在思考",
      };
    }

    const startedAt = run?.firstResponseAt ?? run?.startedAt ?? message.createdAt;
    const endedAt = run?.completedAt ?? now;
    return {
      isThinking: false,
      label: `已处理 ${formatElapsedDuration(endedAt - startedAt)}`,
    };
  }, [message.createdAt, now, run]);

  if (!run) {
    return hasDisplayableContent(message.content) ? (
      <ChatMarkdown className="chat-agent-text" content={message.content} />
    ) : null;
  }

  const timelineCollapsed = canToggleTimeline ? message.uiState?.timelineCollapsed ?? true : false;
  const showTimeline = hasTimeline && !(canToggleTimeline && timelineCollapsed);
  const finalAnswerContent = getLastMessageTimelineContent(timeline) || message.content;
  const showFinalContent =
    hasDisplayableContent(finalAnswerContent) && (!hasTimeline || (canToggleTimeline && timelineCollapsed));
  const isStreamingAssistantText =
    !isRunSettled(run) &&
    Boolean(run.lastResponseAt) &&
    now - (run.lastResponseAt ?? 0) <= ACTIVE_STREAMING_GRACE_MS;
  const showThinkingActivity =
    !(canToggleTimeline && timelineCollapsed) &&
    !headerState.isThinking &&
    !isStreamingAssistantText &&
    shouldShowThinkingActivity(run, timeline);
  const showTokenLimitNotice = isRunSettled(run) && isTokenLimitFinishReason(run.finishReason);
  const webSearchSources = getUniqueWebSearchSources(run);

  return (
    <div className="agent-run">
      <AgentRunElapsedHeader
        canToggle={canToggleTimeline}
        collapsed={timelineCollapsed}
        isThinking={headerState.isThinking}
        label={headerState.label}
        onToggle={() =>
          onUiStateChange?.(message.id, {
            ...message.uiState,
            timelineCollapsed: !timelineCollapsed,
          })
        }
      />
      {showTimeline &&
        timeline.map((item) => (
          <AgentTimelineItemView
            item={item}
            key={item.id}
            message={message}
            onApprove={onApprove}
            onCancel={onCancel}
            onReject={onReject}
            run={run}
          />
        ))}
      {showFinalContent && (
        <ChatMarkdown className="chat-agent-text" content={finalAnswerContent} />
      )}
      {isRunSettled(run) && <AssistantSources sources={webSearchSources} />}
      {showTokenLimitNotice && (
        <div className="agent-run__notice" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>输出可能已达到模型 token 上限而被截断，可以发送“继续”让模型接着写。</span>
        </div>
      )}
      {showThinkingActivity && <AgentThinkingActivity />}
      {showTimeline && run.error && !hasTimelineError && (
        <div className="agent-run__error">{run.error}</div>
      )}
    </div>
  );
}

function MessageContent({
  message,
  onApprove,
  onCancel,
  onReject,
  onUiStateChange,
}: ChatMessageItemProps) {
  if (message.role === "assistant") {
    return (
      <AgentRunView
        message={message}
        onApprove={onApprove}
        onCancel={onCancel}
        onReject={onReject}
        onUiStateChange={onUiStateChange}
      />
    );
  }

  return <ChatMarkdown content={getUserVisibleContent(message)} />;
}

function MessageAttachments({ attachments }: { attachments?: ChatMessage["attachments"] }) {
  if (!attachments?.length) return null;

  const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");
  const fileAttachments = attachments.filter((attachment) => attachment.kind !== "image");
  const renderAttachment = (attachment: NonNullable<ChatMessage["attachments"]>[number]) => {
    const extension = getAttachmentExtension(attachment.name);
    const AttachmentIcon = getAttachmentIcon(attachment.kind, extension);
    const badgeLabel = getAttachmentBadgeLabel(extension);
    const previewUrl = getAttachmentPreviewUrl(attachment);
    const isImagePreview = attachment.kind === "image" && Boolean(previewUrl);

    return (
      <div
        className="chat-message-attachment"
        data-kind={isImagePreview ? "image" : "file"}
        key={attachment.id}
        title={attachment.name}
      >
        {isImagePreview ? (
          <img src={previewUrl} alt={attachment.name} />
        ) : (
          <>
            <span className="chat-message-attachment__icon" aria-hidden="true">
              {badgeLabel ? (
                <span className="chat-message-attachment__badge">{badgeLabel}</span>
              ) : (
                <AttachmentIcon />
              )}
            </span>
            <span className="chat-message-attachment__name">{attachment.name}</span>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="chat-message__attachments" aria-label="附件">
      {imageAttachments.length > 0 && (
        <div className="chat-message__attachment-row" data-kind="image">
          {imageAttachments.map(renderAttachment)}
        </div>
      )}
      {fileAttachments.length > 0 && (
        <div className="chat-message__attachment-row" data-kind="file">
          {fileAttachments.map(renderAttachment)}
        </div>
      )}
    </div>
  );
}

export function ChatMessageItem({
  isLastAssistantMessage = false,
  message,
  onApprove,
  onCancel,
  onReject,
  onUiStateChange,
}: ChatMessageItemProps) {
  const isAssistantActionsVisible = shouldShowAssistantActions(message);
  const userVisibleContent = getUserVisibleContent(message);
  const actionContent = message.role === "assistant" ? getAssistantFinalContent(message) : userVisibleContent;
  const actionTimestamp =
    message.role === "assistant" ? message.agentRun?.completedAt ?? message.createdAt : message.createdAt;
  const showActions = message.role === "user" || isAssistantActionsVisible;
  const pinCopyAction = message.role === "assistant" && isLastAssistantMessage && isAssistantActionsVisible;
  const showBody = message.role === "assistant" || Boolean(userVisibleContent.trim());

  return (
    <article
      className={`chat-message chat-message--${message.role}`}
      data-copy-pinned={pinCopyAction ? "true" : undefined}
      data-status={message.status}
      key={message.id}
    >
      {message.role === "user" && <MessageAttachments attachments={message.attachments} />}
      {showBody && (
        <div className="chat-message__body">
          <MessageContent
            message={message}
            onApprove={onApprove}
            onCancel={onCancel}
            onReject={onReject}
            onUiStateChange={onUiStateChange}
          />
        </div>
      )}
      {showActions && <ChatMessageActions content={actionContent} timestamp={actionTimestamp} />}
    </article>
  );
}
