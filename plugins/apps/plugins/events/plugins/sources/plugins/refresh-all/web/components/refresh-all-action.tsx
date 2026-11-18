import type { ReactElement } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  useToast,
  type ToastArgs,
} from "@plugins/shell/plugins/notifications/web";
import { useRefreshAllEventSources } from "@plugins/apps/plugins/events/plugins/events-core/web";
import type { RefreshAllResult } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const refreshIcon = symbol("refresh");

/**
 * Turn one `RefreshAllResult` into the toast that reports it — arm by arm,
 * the same discipline the single-source `RefreshSourceResult` gets in the
 * schedule section, for the same reason: a resolved promise is NOT
 * "everything refreshed", and a tally is only worth returning if the caller
 * renders all of it.
 *
 * Each count is a genuinely different thing the user needs to know when the
 * list does not move afterwards:
 *
 * - `enqueued` — runs that will actually start.
 * - `alreadyRunning` — sources mid-run; the request joined the run in flight
 *   rather than starting a second one.
 * - `skipped` — a source disabled between the server's listing and its own
 *   enqueue. Rare and racy, but a real refusal of a request we did make, which
 *   is why the tally carries it at all. A source that was simply disabled all
 *   along is counted NOWHERE — nothing was asked of it, so it is not a skip.
 *
 * Never `success`: what succeeded is the *enqueue*, and the runs have not
 * happened yet. Claiming success for work that has not started is exactly the
 * over-statement the arms exist to avoid.
 */
function describeRefreshAll(result: RefreshAllResult): ToastArgs {
  const { enqueued, alreadyRunning, skipped } = result;

  // Nothing was even asked of anything. The honest answer, and specifically not
  // a success chirp: the user pressed refresh and no run was started.
  if (enqueued === 0 && alreadyRunning === 0 && skipped === 0) {
    return {
      type: "events-refresh-all",
      title: "Nothing to refresh",
      description: "Every source is disabled, so no run was started.",
      variant: "info",
      category: "other",
    };
  }

  const notes: string[] = [];
  if (enqueued > 0) {
    notes.push(
      enqueued === 1 ? "The run starts shortly." : "The runs start shortly.",
    );
  }
  if (alreadyRunning > 0) {
    notes.push(
      `${alreadyRunning} ${alreadyRunning === 1 ? "was" : "were"} already running and joined that run.`,
    );
  }
  if (skipped > 0) {
    notes.push(
      `${skipped} ${skipped === 1 ? "was" : "were"} disabled in the meantime, so nothing started for ${skipped === 1 ? "it" : "them"}.`,
    );
  }

  return {
    type: "events-refresh-all",
    title:
      enqueued > 0
        ? `Refreshing ${enqueued} ${enqueued === 1 ? "source" : "sources"}`
        : alreadyRunning > 0
          ? "Already refreshing"
          : "Nothing started",
    description: notes.join(" "),
    // A refusal is the one arm the user might want to act on, so it colours the
    // whole toast; everything else is a statement of what is now in flight.
    variant: skipped > 0 ? "warning" : "info",
    category: "other",
  };
}

/**
 * "Refresh all" in the sources pane toolbar.
 *
 * The whole feature is this one folder, contributed into `eventSourcesPane`'s
 * own `Actions` slot — the pane names nothing about refreshing, and removing
 * this plugin removes the button with no edit there.
 *
 * A failure is NOT reported here. `useRefreshAllEventSources` passes no
 * `onError`, so `useEndpointMutation` leaves the global mutation toast armed
 * and a failed request already surfaces one; adding a second would
 * double-report the same error.
 */
export function RefreshAllAction(): ReactElement {
  const refreshAll = useRefreshAllEventSources();
  const toast = useToast();

  return (
    <IconButton
      // The pending state is the same button with the same glyph, spinning —
      // no extra chrome, no size change.
      icon={refreshIcon}
      motion={refreshAll.isPending ? "spin" : undefined}
      label="Refresh all sources"
      disabled={refreshAll.isPending}
      onClick={() => {
        refreshAll.mutate(
          // No path params and no body — the endpoint refreshes the whole
          // set, so there is nothing to address it with.
          {},
          { onSuccess: (result) => toast(describeRefreshAll(result)) },
        );
      }}
    />
  );
}
