import type { AgentToolCall, AgentToolResult } from "@agent";
import type { ChatWebSearchActivity } from "../../chatTypes";
import { GenericToolActivity } from "./GenericToolActivity";
import { WebSearchToolActivity } from "./WebSearchToolActivity";

interface AgentToolActivityProps {
  activity?: ChatWebSearchActivity;
  call: AgentToolCall;
  result?: AgentToolResult;
}

export function AgentToolActivity({ activity, call, result }: AgentToolActivityProps) {
  if (call.tool === "web_search") {
    return <WebSearchToolActivity activity={activity} call={call} result={result} />;
  }

  return <GenericToolActivity call={call} result={result} />;
}
