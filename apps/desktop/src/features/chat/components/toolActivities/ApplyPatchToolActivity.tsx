import { FilePenLine, FilePlus2, FileX2 } from "lucide-react";
import type {
  AgentDiffProposal,
  AgentPatchOperation,
  AgentPatchResult,
  AgentToolCall,
  AgentToolResult,
} from "@agent";
import type { TranslationKey } from "../../../../config/frontendTranslations";
import { useFrontendConfig } from "../../../../config/FrontendConfigProvider";
import { AgentActivityDisclosure } from "./AgentActivityDisclosure";

interface ApplyPatchToolActivityProps {
  cancelled?: boolean;
  call: AgentToolCall;
  diff?: AgentDiffProposal;
  result?: AgentToolResult;
}

type ApplyPatchStatus = "waiting" | "running" | "applied" | "failed" | "rejected" | "cancelled";

const LABELS: Record<AgentPatchOperation, Record<ApplyPatchStatus, TranslationKey>> = {
  create: {
    waiting: "agent.patch.create.waiting",
    running: "agent.patch.create.running",
    applied: "agent.patch.create.applied",
    failed: "agent.patch.create.failed",
    rejected: "agent.patch.create.rejected",
    cancelled: "agent.patch.create.cancelled",
  },
  update: {
    waiting: "agent.patch.update.waiting",
    running: "agent.patch.update.running",
    applied: "agent.patch.update.applied",
    failed: "agent.patch.update.failed",
    rejected: "agent.patch.update.rejected",
    cancelled: "agent.patch.update.cancelled",
  },
  delete: {
    waiting: "agent.patch.delete.waiting",
    running: "agent.patch.delete.running",
    applied: "agent.patch.delete.applied",
    failed: "agent.patch.delete.failed",
    rejected: "agent.patch.delete.rejected",
    cancelled: "agent.patch.delete.cancelled",
  },
};

const ICONS = {
  create: FilePlus2,
  update: FilePenLine,
  delete: FileX2,
} satisfies Record<AgentPatchOperation, typeof FilePenLine>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function getOperation(value: unknown): AgentPatchOperation | undefined {
  return value === "create" || value === "update" || value === "delete" ? value : undefined;
}

function getPatchResult(result: AgentToolResult | undefined): AgentPatchResult | undefined {
  if (!isRecord(result?.result)) return undefined;
  const status = result.result.status;
  const operation = getOperation(result.result.operation);
  const filePath = getString(result.result.filePath);
  const appliedFilePaths = result.result.appliedFilePaths;
  if (
    (status !== "applied" && status !== "failed" && status !== "rejected")
    || !operation
    || !filePath
    || !Array.isArray(appliedFilePaths)
  ) {
    return undefined;
  }

  return result.result as unknown as AgentPatchResult;
}

function getCallArgs(call: AgentToolCall) {
  return isRecord(call.args) ? call.args : {};
}

function getStatus(
  call: AgentToolCall,
  result: AgentToolResult | undefined,
  patchResult: AgentPatchResult | undefined,
  cancelled: boolean,
): ApplyPatchStatus {
  if (patchResult?.status === "applied") return "applied";
  if (patchResult?.status === "failed") return "failed";
  if (patchResult?.status === "rejected") return "rejected";
  if (result?.ok === false) return "failed";
  if (call.approvalStatus === "rejected") return "rejected";
  if (cancelled) return "cancelled";
  if (call.approvalStatus === "required") return "waiting";
  return "running";
}

export function ApplyPatchToolActivity({
  cancelled = false,
  call,
  diff,
  result,
}: ApplyPatchToolActivityProps) {
  const { t } = useFrontendConfig();
  const args = getCallArgs(call);
  const patchResult = getPatchResult(result);
  const operation = patchResult?.operation ?? diff?.operation ?? getOperation(args.operation) ?? "update";
  const status = getStatus(call, result, patchResult, cancelled);
  const filePath = patchResult?.filePath ?? diff?.filePath ?? getString(args.filePath);
  const summary = (diff?.summary ?? getString(args.summary)) || call.reason;
  const patch = diff?.patch ?? getString(args.patch);
  const message = patchResult?.message;
  const error = patchResult?.error ?? result?.error;
  const hasDetails = Boolean(filePath || summary || patch || message || error);
  const Icon = ICONS[operation];

  return (
    <AgentActivityDisclosure
      className="agent-activity--apply-patch"
      hasDetails={hasDetails}
      icon={Icon}
      isPending={status === "waiting" || status === "running"}
      label={t(LABELS[operation][status])}
    >
      {hasDetails ? (
        <div className="agent-activity__details apply-patch-activity__details">
          {filePath ? <p className="apply-patch-activity__path">{filePath}</p> : null}
          {summary ? <p>{summary}</p> : null}
          {message ? (
            <p>
              <span>{t("agent.patch.rejectReason")}</span>
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="apply-patch-activity__error">
              <span>{t("agent.detail.error")}</span>
              {error}
            </p>
          ) : null}
          {patch ? <pre>{patch}</pre> : null}
        </div>
      ) : null}
    </AgentActivityDisclosure>
  );
}
