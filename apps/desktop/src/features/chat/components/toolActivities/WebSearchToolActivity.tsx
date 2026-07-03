import { ChevronDown, Globe2 } from "lucide-react";
import type { AgentToolCall, AgentToolResult } from "@agent";
import type { ChatWebSearchActivity } from "../../chatTypes";
import { WebSearchSourcesList } from "./WebSearchSources";

interface WebSearchToolActivityProps {
  activity?: ChatWebSearchActivity;
  call: AgentToolCall;
  result?: AgentToolResult;
}

function getWebSearchStatusLabel(activity: ChatWebSearchActivity | undefined, result?: AgentToolResult) {
  if (activity?.status === "failed" || result?.ok === false) return "联网搜索失败";
  if (activity?.status === "completed" || result) return "已搜索网页";
  return "正在联网搜索";
}

export function WebSearchToolActivity({ activity, result }: WebSearchToolActivityProps) {
  const hasDetails = Boolean(
    activity?.query ||
      activity?.sources.length ||
      activity?.answer ||
      activity?.error ||
      result?.error,
  );
  const label = getWebSearchStatusLabel(activity, result);
  const isPending = !result && activity?.status !== "completed" && activity?.status !== "failed";

  return (
    <details className="agent-activity agent-activity--web-search">
      <summary>
        <Globe2 aria-hidden="true" />
        <span className={isPending ? "agent-running-text" : undefined}>{label}</span>
        {hasDetails && <ChevronDown className="agent-activity__chevron" aria-hidden="true" />}
      </summary>
      {hasDetails && (
        <div className="agent-activity__details web-search-activity__details">
          {activity?.query && (
            <p className="web-search-activity__query">
              <span>搜索</span>
              {activity.query}
            </p>
          )}
          {activity?.error || result?.error ? (
            <>
              <span>错误</span>
              <pre>{activity?.error ?? result?.error}</pre>
            </>
          ) : null}
          {activity?.sources && <WebSearchSourcesList sources={activity.sources} />}
          {activity?.answer && (
            <p className="web-search-activity__answer">
              <span>摘要</span>
              {activity.answer}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
