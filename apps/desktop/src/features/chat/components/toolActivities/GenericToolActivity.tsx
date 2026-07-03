import { CheckCircle2, ChevronDown, SquareTerminal, XCircle } from "lucide-react";
import type { AgentToolCall, AgentToolResult } from "@agent";
import { formatToolDetails, getToolCallLabel } from "./toolActivityUtils";

interface GenericToolActivityProps {
  call: AgentToolCall;
  result?: AgentToolResult;
}

export function GenericToolActivity({ call, result }: GenericToolActivityProps) {
  const hasDetails = call.args !== undefined || call.reason || result;
  const Icon = result?.ok === false ? XCircle : result ? CheckCircle2 : SquareTerminal;
  const isPending = !result;

  return (
    <details className="agent-activity">
      <summary>
        <Icon aria-hidden="true" />
        <span className={isPending ? "agent-running-text" : undefined}>
          {getToolCallLabel(call, result)}
        </span>
        {hasDetails && <ChevronDown className="agent-activity__chevron" aria-hidden="true" />}
      </summary>
      {hasDetails && (
        <div className="agent-activity__details">
          {call.reason && <p>{call.reason}</p>}
          {call.args !== undefined && (
            <>
              <span>参数</span>
              <pre>{formatToolDetails(call.args)}</pre>
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
              <pre>{formatToolDetails(result.result)}</pre>
            </>
          )}
        </div>
      )}
    </details>
  );
}
