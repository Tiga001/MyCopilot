import type { AgentToolCall, AgentToolResult } from "@agent";
import type { ChatReadActivity, ChatWebSearchActivity } from "../../chatTypes";
import { isReadActivityTool } from "../../agentReadActivities";
import { GenericToolActivity } from "./GenericToolActivity";
import { ReadToolActivity } from "./ReadToolActivity";
import { WebSearchToolActivity } from "./WebSearchToolActivity";

interface AgentToolActivityProps {
  cancelled?: boolean;
  readActivity?: ChatReadActivity;
  webActivity?: ChatWebSearchActivity;
  call: AgentToolCall;
  result?: AgentToolResult;
}

export function AgentToolActivity({
  cancelled = false,
  readActivity,
  webActivity,
  call,
  result,
}: AgentToolActivityProps) {
  if (call.tool === "web_search" || call.tool === "web_fetch") {
    return <WebSearchToolActivity activity={webActivity} call={call} result={result} />;
  }

  if (isReadActivityTool(call.tool)) {
    return <ReadToolActivity activity={readActivity} call={call} result={result} />;
  }

  return <GenericToolActivity cancelled={cancelled && !result} call={call} result={result} />;
}
