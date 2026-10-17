import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { BouncingDots } from "@plugins/primitives/plugins/css/plugins/bouncing-dots/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { bundleRefusalMessage } from "@plugins/release/plugins/bundles/core";
import {
  releaseStateLabel,
  stalenessSentence,
  type ReleaseState,
} from "../../core";
import type {
  ReleaseInfo,
  ReleaseSnapshot,
} from "../internal/use-release-info";

const DOT_COLOR: Record<ReleaseState, string> = {
  building: "bg-info",
  failed: "bg-destructive",
  none: "bg-muted-foreground",
  "platform-mismatch": "bg-destructive",
  stale: "bg-warning",
  built: "bg-success",
};

type Resolved = Extract<ReleaseSnapshot, { kind: "resolved" }>;

/**
 * The full sentence behind the chip — the `title`, because a chip sits in the
 * row's rigid trailing region and cannot hold a refusal. The refusal text is the
 * CLI's own, rendered verbatim: this UI never re-derives shippability, and never
 * paraphrases the one wording `ship` prints.
 */
function tooltipFor(info: Resolved): string {
  const { state, candidate, latestRun } = info;
  if (state === "building") return "A release of this composition is running.";

  if (!candidate.resolution.ok) {
    const refusal = bundleRefusalMessage(candidate.resolution.refusal);
    return latestRun?.status === "failed" && latestRun.error
      ? `${refusal}\n\nThe last build failed: ${latestRun.error}`
      : refusal;
  }
  return `${candidate.resolution.binaryName}\n${stalenessSentence(candidate.staleness)}`;
}

/**
 * One deployment's release state as the row's trailing chip.
 *
 * Deliberately one line and no timestamp: `RelativeTime` belongs in the pane,
 * where there is room to say what it is relative to. Every state renders: no
 * platform (or no probe yet) is an empty cell — there is no question to ask —
 * while a pending answer shows a spinner and a failed one its error.
 */
export function ReleaseChip({
  info,
}: {
  info: ReleaseInfo | undefined;
}): ReactNode {
  if (info === undefined) return null;
  switch (info.status) {
    case "loading":
      return <Loading variant="spinner" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="icon"
          error={info.error}
          refetch={info.refetch}
          subject="the release"
        />
      );
    case "ready":
      break;
  }
  if (info.data.kind === "no-platform") return null;
  return <ResolvedChip info={info.data} />;
}

function ResolvedChip({ info }: { info: Resolved }): ReactNode {
  const { state } = info;

  if (state === "building") {
    return (
      <Badge variant="info" icon={<BouncingDots />} tooltip={tooltipFor(info)}>
        {releaseStateLabel(state)}
      </Badge>
    );
  }

  return (
    <Badge
      variant="muted"
      icon={<StatusDot colorClass={DOT_COLOR[state]} />}
      tooltip={tooltipFor(info)}
    >
      {releaseStateLabel(state)}
    </Badge>
  );
}
