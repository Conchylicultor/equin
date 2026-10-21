import type { ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  useThreadProgress,
  useThreadRuns,
} from "@plugins/conversations/plugins/agent-thread/web";
import type { ThreadRun } from "@plugins/conversations/plugins/agent-thread/core";
import {
  PLACES_ASK_PROFILE,
  placesPicks,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import { questionOfTitle } from "../internal/use-ask";

const historyIcon = symbol("forum");
const RESULTS = [placesPicks];

/** How many recent questions the search panel lists. */
const HISTORY_SHOWN = 5;

/**
 * "Recent questions" in the search panel (with nothing typed): the latest Ask
 * Sonnet runs, newest first — each its question, where it stands (working /
 * N picks / closed) and when it was asked; picking one reopens it in the side
 * card (a closed one too: replying resumes it). Nothing before the first
 * question.
 *
 * Panel rows, not a DataView: a short, fixed picker inside the search popover
 * (like "Your places" above it), the full list living in the Agent Manager.
 */
export function AskHistory({
  onOpenRun,
}: {
  onOpenRun: (conversationId: string) => void;
}): ReactNode {
  const runs = useThreadRuns(PLACES_ASK_PROFILE, { limit: HISTORY_SHOWN });
  if (runs.status === "ready" && runs.data.length === 0) return null;
  return (
    <ControlPanel.Section label="Recent questions">
      {runs.status === "loading" ? (
        <Loading variant="rows" count={2} />
      ) : runs.status === "error" ? (
        <ResourceErrorInline
          variant="block"
          subject="your recent questions"
          error={runs.error}
          refetch={runs.refetch}
        />
      ) : (
        runs.data.map((run) => (
          <ControlPanel.Row
            key={run.id}
            icon={<Icon icon={historyIcon} />}
            trailing={<RunMeta run={run} />}
            onSelect={() => onOpenRun(run.id)}
          >
            {run.title === null
              ? "Untitled question"
              : questionOfTitle(run.title)}
          </ControlPanel.Row>
        ))
      )}
    </ControlPanel.Section>
  );
}

/** "3 picks · 2h", "working · now", "closed · 3d". */
function RunMeta({ run }: { run: ThreadRun }): ReactNode {
  const closed = run.status === "done" || run.status === "gone";
  // A closed run says so without reading its transcript.
  const progress = useThreadProgress(closed ? null : run.id, RESULTS);
  const p = progress.status === "ready" ? progress.data : null;
  const state = closed
    ? "closed"
    : progress.status === "loading"
      ? "…"
      : progress.status === "error"
        ? "unreadable"
        : p === null
          ? "gone"
          : p.state === "working"
            ? "working"
            : p.state === "waiting"
              ? "waiting for you"
              : p.state === "failed"
                ? "stopped"
                : p.resultCount === 0
                  ? "answered"
                  : `${p.resultCount} pick${p.resultCount === 1 ? "" : "s"}`;
  return (
    <Text variant="caption" tone="muted">
      {`${state} · ${formatRelativeTime(run.createdAt, "short")}`}
    </Text>
  );
}
