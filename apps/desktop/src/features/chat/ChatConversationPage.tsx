import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  PencilLine,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import { ChatComposer } from "./components/ChatComposer";
import type {
  ChatAgentRunView,
  ChatAgentTimelineItem,
  ChatConversation,
  ChatMessage,
  ChatSubmitOptions,
} from "./chatTypes";
import "./ChatConversationPage.css";
import type { AgentProposedAction, AgentToolCall, AgentToolResult } from "@agent";

interface ChatConversationPageProps {
  conversation: ChatConversation;
  onApproveAgentAction?: (messageId: string, action: AgentProposedAction) => void;
  onCancelAgentAction?: (messageId: string, action: AgentProposedAction) => void;
  onRejectAgentAction?: (messageId: string, action: AgentProposedAction) => void;
  onStopGenerating?: () => void;
  onSubmitMessage: (message: string, options: ChatSubmitOptions) => void;
}

function formatDetails(value: unknown) {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function getToolDisplayName(tool: string) {
  const labels: Record<string, string> = {
    apply_patch: "应用修改",
    attachments_list: "列出对话附件",
    attachments_list_project: "列出项目附件",
    generate_patch: "生成修改",
    git_diff: "读取 Git diff",
    read_file: "读取文件",
    read_image: "读取图片",
    read_pdf: "读取 PDF",
    read_presentation: "读取演示文稿",
    read_spreadsheet: "读取表格",
    read_word: "读取文档",
    run_command: "运行命令",
    search_code: "搜索代码",
    search_files: "列出文件",
    web_fetch: "读取网页",
    web_search: "联网搜索",
  };

  return labels[tool] ?? tool;
}

function getToolCallLabel(call: AgentToolCall, result?: AgentToolResult) {
  const name = getToolDisplayName(call.tool);

  if (!result) {
    return call.approvalStatus === "required" ? `等待审批 ${name}` : `正在${name}`;
  }

  if (!result.ok) {
    return `${name}失败`;
  }

  return `已${name}`;
}

function getRunStatusLabel(run: ChatAgentRunView) {
  if (run.status === "starting") return "正在连接";
  if (run.status === "running") return "正在处理";
  if (run.status === "waiting_for_approval") return "等待审批";
  if (run.status === "failed") return "处理失败";
  if (run.status === "cancelled") return "已停止";
  return "已处理";
}

function AgentToolActivity({ call, result }: { call: AgentToolCall; result?: AgentToolResult }) {
  const hasDetails = call.args !== undefined || call.reason || result;
  const Icon = result?.ok === false ? XCircle : result ? CheckCircle2 : SquareTerminal;

  return (
    <details className="agent-activity">
      <summary>
        <Icon aria-hidden="true" />
        <span>{getToolCallLabel(call, result)}</span>
        {hasDetails && <ChevronDown className="agent-activity__chevron" aria-hidden="true" />}
      </summary>
      {hasDetails && (
        <div className="agent-activity__details">
          {call.reason && <p>{call.reason}</p>}
          {call.args !== undefined && (
            <>
              <span>参数</span>
              <pre>{formatDetails(call.args)}</pre>
            </>
          )}
          {result?.error && (
            <>
              <span>错误</span>
              <pre>{result.error}</pre>
            </>
          )}
          {result?.result !== undefined && (
            <>
              <span>结果</span>
              <pre>{formatDetails(result.result)}</pre>
            </>
          )}
        </div>
      )}
    </details>
  );
}

function AgentDiffActivity({ run, diffId }: { run: ChatAgentRunView; diffId: string }) {
  const diff = run.diffs.find((candidate) => candidate.id === diffId);
  if (!diff) return null;

  return (
    <details className="agent-activity agent-activity--diff">
      <summary>
        <PencilLine aria-hidden="true" />
        <span>
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
  return action.call.reason ?? formatDetails(action.call.args);
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
    return <p className="chat-agent-text">{item.content}</p>;
  }

  if (item.type === "tool_call") {
    const call = run.toolCalls.find((candidate) => candidate.id === item.callId);
    if (!call) return null;
    return <AgentToolActivity call={call} result={getToolResult(run, call.id)} />;
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
}: {
  message: ChatMessage;
  onApprove?: (messageId: string, action: AgentProposedAction) => void;
  onCancel?: (messageId: string, action: AgentProposedAction) => void;
  onReject?: (messageId: string, action: AgentProposedAction) => void;
}) {
  const run = message.agentRun;
  const timeline = run?.timeline ?? [];
  const hasTimeline = timeline.length > 0;
  const hasTimelineError = timeline.some((item) => item.type === "error");

  if (!run || !hasTimeline) {
    return message.content ? <p className="chat-agent-text">{message.content}</p> : null;
  }

  return (
    <div className="agent-run">
      <div className="agent-run__status">
        <span>{getRunStatusLabel(run)}</span>
      </div>
      {timeline.map((item) => (
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
      {run.error && !hasTimelineError && <div className="agent-run__error">{run.error}</div>}
    </div>
  );
}

function MessageContent({
  message,
  onApprove,
  onCancel,
  onReject,
}: {
  message: ChatMessage;
  onApprove?: (messageId: string, action: AgentProposedAction) => void;
  onCancel?: (messageId: string, action: AgentProposedAction) => void;
  onReject?: (messageId: string, action: AgentProposedAction) => void;
}) {
  if (message.role === "assistant") {
    return (
      <AgentRunView
        message={message}
        onApprove={onApprove}
        onCancel={onCancel}
        onReject={onReject}
      />
    );
  }

  return <p>{message.content}</p>;
}

export function ChatConversationPage({
  conversation,
  onApproveAgentAction,
  onCancelAgentAction,
  onRejectAgentAction,
  onStopGenerating,
  onSubmitMessage,
}: ChatConversationPageProps) {
  const isGenerating = conversation.messages.some(
    (message) => message.role === "assistant" && message.status === "pending",
  );

  return (
    <section className="chat-conversation-page" aria-label={conversation.title}>
      <div className="chat-conversation-page__messages">
        {conversation.messages.map((message) => (
          <article
            className={`chat-message chat-message--${message.role}`}
            data-status={message.status}
            key={message.id}
          >
            <MessageContent
              message={message}
              onApprove={onApproveAgentAction}
              onCancel={onCancelAgentAction}
              onReject={onRejectAgentAction}
            />
          </article>
        ))}
      </div>

      <div className="chat-conversation-page__composer">
        <ChatComposer
          isGenerating={isGenerating}
          onStopGenerating={onStopGenerating}
          onSubmitMessage={onSubmitMessage}
        />
      </div>
    </section>
  );
}
