import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  createEventSource,
  deleteEventSource,
  getEventSource,
  listEventSources,
  refreshAllEventSources,
  refreshEventSourceNow,
  updateEventSource,
} from "../../core";
import {
  createSource,
  deleteSource,
  listSources,
  requireSource,
  updateSource,
} from "./sources-repo";
import { requestSourceRefresh } from "./refresh-runner";

export const handleListSources = implement(listEventSources, async () =>
  listSources(),
);

export const handleGetSource = implement(getEventSource, async ({ params }) =>
  requireSource(params.id),
);

export const handleCreateSource = implement(
  createEventSource,
  async ({ body }) => createSource(body),
);

export const handleUpdateSource = implement(
  updateEventSource,
  async ({ params, body }) => updateSource(params.id, body),
);

export const handleDeleteSource = implement(
  deleteEventSource,
  async ({ params }) => {
    await deleteSource(params.id);
  },
);

// 404s on an unknown id BEFORE reaching the engine, so "Refresh now" on a
// deleted source is an error rather than a silently-dropped enqueue.
export const handleRefreshSource = implement(
  refreshEventSourceNow,
  async ({ params }) => {
    await requireSource(params.id);
    return requestSourceRefresh(params.id);
  },
);

/**
 * "Refresh all" — every ENABLED source, tallied by the same arms one source
 * would have answered with.
 *
 * A disabled source is not a candidate at all, so it is skipped before the
 * engine is asked and counted nowhere; `skipped` only ever holds a refusal of a
 * request we actually made (the row was disabled between this listing and its
 * own enqueue).
 *
 * Sequential `for`/`await`, deliberately not `Promise.all`: an enqueue is cheap
 * and ordered, so there is nothing to win by fanning out, and a throw must
 * surface loudly as a failed request rather than being folded into a
 * settled-results array nobody inspects. A partial enqueue is harmless —
 * `refreshSourceJob` dedups per source, so the sources already enqueued simply
 * run, and pressing the button again picks up the rest.
 */
export const handleRefreshAll = implement(refreshAllEventSources, async () => {
  const tally = { enqueued: 0, alreadyRunning: 0, skipped: 0 };
  for (const source of await listSources()) {
    if (!source.enabled) continue;
    const result = await requestSourceRefresh(source.id);
    // Exhaustive on purpose: a new arm in `RefreshSourceResult` becomes a tsc
    // error right here instead of being silently uncounted, which is the one
    // way a tally can lie without anything looking broken.
    switch (result.status) {
      case "enqueued":
        tally.enqueued += 1;
        break;
      case "already-running":
        tally.alreadyRunning += 1;
        break;
      case "skipped":
        tally.skipped += 1;
        break;
      default: {
        const _exhaustive: never = result;
        throw new Error(`unhandled refresh result: ${String(_exhaustive)}`);
      }
    }
  }
  return tally;
});
