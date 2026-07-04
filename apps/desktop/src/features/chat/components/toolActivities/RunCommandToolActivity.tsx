import { CheckCircle2, SquareTerminal, XCircle } from "lucide-react";
import type { AgentToolCall, AgentToolResult } from "@agent";
import { useFrontendConfig } from "../../../../config/FrontendConfigProvider";
import { AgentActivityDisclosure } from "./AgentActivityDisclosure";
import { formatToolDetails, getToolCallLabel } from "./toolActivityUtils";

interface RunCommandToolActivityProps {
  cancelled?: boolean;
  call: AgentToolCall;
  result?: AgentToolResult;
}

function getObjectValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getStringField(value: unknown, key: string) {
  const objectValue = getObjectValue(value);
  const fieldValue = objectValue?.[key];
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue.trim() : "";
}

function getRunCommandDetails(call: AgentToolCall) {
  return {
    command: getStringField(call.args, "command"),
    reason: getStringField(call.args, "reason") || call.reason || "",
  };
}

export function RunCommandToolActivity({
  cancelled = false,
  call,
  result,
}: RunCommandToolActivityProps) {
  const { t } = useFrontendConfig();
  const details = getRunCommandDetails(call);
  const hasApprovalDetails = !result && !cancelled && Boolean(details.reason || details.command);
  const hasResultDetails = Boolean(result?.error || result?.result !== undefined);
  const Icon = result?.ok === false ? XCircle : result ? CheckCircle2 : SquareTerminal;
  const isPending = !result && !cancelled;

  return (
    <AgentActivityDisclosure
      hasDetails={hasApprovalDetails || hasResultDetails}
      icon={Icon}
      isPending={isPending}
      label={getToolCallLabel(call, result, t, { cancelled })}
    >
      {(hasApprovalDetails || hasResultDetails) && (
        <div className="agent-activity__details">
          {hasApprovalDetails && (
            <>
              {details.reason && <p>{details.reason}</p>}
              {details.command && <pre>{details.command}</pre>}
            </>
          )}
          {result?.error && (
            <>
              <span>{t("agent.detail.error")}</span>
              <pre>{result.error}</pre>
            </>
          )}
          {result?.result !== undefined && (
            <>
              <span>{t("agent.detail.result")}</span>
              <pre>{formatToolDetails(result.result)}</pre>
            </>
          )}
        </div>
      )}
    </AgentActivityDisclosure>
  );
}
