import { ChevronDown, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface AgentActivityDisclosureProps {
  children?: ReactNode;
  className?: string;
  hasDetails: boolean;
  icon: LucideIcon;
  isPending?: boolean;
  label: string;
}

export function AgentActivityDisclosure({
  children,
  className,
  hasDetails,
  icon: Icon,
  isPending = false,
  label,
}: AgentActivityDisclosureProps) {
  const activityClassName = ["agent-activity", className].filter(Boolean).join(" ");
  const labelNode = <span className={isPending ? "agent-running-text" : undefined}>{label}</span>;

  if (!hasDetails) {
    return (
      <div className={activityClassName}>
        <div className="agent-activity__static-summary">
          <Icon aria-hidden="true" />
          {labelNode}
        </div>
      </div>
    );
  }

  return (
    <details className={activityClassName}>
      <summary>
        <Icon aria-hidden="true" />
        {labelNode}
        <ChevronDown className="agent-activity__chevron" aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}
