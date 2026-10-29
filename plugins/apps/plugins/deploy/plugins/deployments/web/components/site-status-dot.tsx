import type { ReactElement } from "react";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SITE_STATUSES, type SiteStatus } from "../internal/site-status";

/** How each status reads: its dot's paint and its words. */
export const SITE_STATUS_PRESENTATION: Record<
  SiteStatus,
  { colorClass: string; variant: BadgeVariant; label: string }
> = {
  live: { colorClass: "bg-success", variant: "success", label: "Live" },
  deploying: {
    colorClass: "bg-primary",
    variant: "primary",
    label: "Deploying",
  },
  failed: {
    colorClass: "bg-destructive",
    variant: "destructive",
    label: "Failed",
  },
  "needs-approval": {
    colorClass: "bg-warning",
    variant: "warning",
    label: "Needs approval",
  },
  pending: {
    colorClass: "bg-muted-foreground",
    variant: "muted",
    label: "Not deployed",
  },
};

/** The statuses as filter / group options, in their declared order. */
export const SITE_STATUS_OPTIONS = SITE_STATUSES.map((value) => ({
  value,
  label: SITE_STATUS_PRESENTATION[value].label,
}));

/** A filled dot painted for `status`, labelled for assistive tech. */
export function SiteStatusMark({
  status,
}: {
  status: SiteStatus;
}): ReactElement {
  const { colorClass, label } = SITE_STATUS_PRESENTATION[status];
  return (
    <span role="img" aria-label={label} title={label}>
      <StatusDot colorClass={colorClass} />
    </span>
  );
}

/**
 * The status as a labelled pill — dot + words in the status's own tint — for a
 * row, card or header that names it. A deploy in flight pulses its dot.
 */
export function SiteStatusPill({
  status,
}: {
  status: SiteStatus;
}): ReactElement {
  const { variant, label } = SITE_STATUS_PRESENTATION[status];
  return (
    <Badge
      variant={variant}
      shape="pill"
      icon={
        <StatusDot
          colorClass={cn(
            "bg-current",
            status === "deploying" && "animate-pulse",
          )}
        />
      }
    >
      {label}
    </Badge>
  );
}
