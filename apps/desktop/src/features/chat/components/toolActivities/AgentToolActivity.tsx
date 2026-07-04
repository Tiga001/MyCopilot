import type { AgentToolCall, AgentToolResult } from "@agent";
import type { ChatReadActivity, ChatWebSearchActivity } from "../../chatTypes";
import { isReadActivityTool } from "../../agentReadActivities";
import { AttachmentListToolActivity } from "./AttachmentListToolActivity";
import { GenericToolActivity } from "./GenericToolActivity";
import { GitDiffToolActivity } from "./GitDiffToolActivity";
import { ReadToolActivity } from "./ReadToolActivity";
import { RunCommandToolActivity } from "./RunCommandToolActivity";
import { SearchToolActivity } from "./SearchToolActivity";
import { WebSearchToolActivity } from "./WebSearchToolActivity";
import { WorkspaceMapToolActivity } from "./WorkspaceMapToolActivity";

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
  if (call.tool === "attachments_list" || call.tool === "attachments_list_project") {
    return <AttachmentListToolActivity cancelled={cancelled && !result} call={call} result={result} />;
  }

  if (call.tool === "web_search" || call.tool === "web_fetch") {
    return <WebSearchToolActivity activity={webActivity} call={call} result={result} />;
  }

  if (isReadActivityTool(call.tool)) {
    return <ReadToolActivity activity={readActivity} call={call} result={result} />;
  }

  if (call.tool === "workspace_map") {
    return <WorkspaceMapToolActivity cancelled={cancelled && !result} result={result} />;
  }

  if (call.tool === "search_files" || call.tool === "search_code") {
    return <SearchToolActivity cancelled={cancelled && !result} call={call} result={result} />;
  }

  if (call.tool === "git_diff") {
    return <GitDiffToolActivity cancelled={cancelled && !result} call={call} result={result} />;
  }

  if (call.tool === "run_command") {
    return <RunCommandToolActivity cancelled={cancelled && !result} call={call} result={result} />;
  }

  return <GenericToolActivity cancelled={cancelled && !result} call={call} result={result} />;
}
