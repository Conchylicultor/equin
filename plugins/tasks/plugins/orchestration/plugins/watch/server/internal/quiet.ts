import { and, eq, ne } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import { QUIET_EVENT_KIND, watchEventIdKind, type WatchId } from "../../core";
import { getWatch, isWatchLive, subtreeActive } from "./queries";
import { _taskWatches, _watchInbox } from "./tables";

export type QuietOutcome =
  | "not-live"
  | "unchanged"
  | "became-busy"
  /** Flipped to quiet: a `quiet` event is in the watch's inbox. */
  | "became-quiet";

/**
 * Re-evaluate whether a watch's subtree is quiet and record a flip. Only a
 * false → true flip raises a `quiet` event (once per transition); true → false
 * only moves the column. The watcher's own conversation never counts as
 * activity — a watcher on its own subtree is not kept busy by itself.
 */
export async function evaluateQuiet(
  exec: DbExecutor,
  watchId: WatchId,
): Promise<QuietOutcome> {
  const watch = await getWatch(exec, watchId);
  if (watch === null || !(await isWatchLive(exec, watchId))) return "not-live";
  const quiet = !(await subtreeActive(
    exec,
    watch.taskId,
    watch.watcherConversationId,
  ));
  const [flipped] = await exec
    .update(_taskWatches)
    .set({ quiet })
    .where(and(eq(_taskWatches.id, watchId), ne(_taskWatches.quiet, quiet)))
    .returning({ id: _taskWatches.id });
  if (!flipped) return "unchanged";
  if (!quiet) return "became-busy";
  await exec.insert(_watchInbox).values({
    id: watchEventIdKind.mint(),
    watchId,
    kind: QUIET_EVENT_KIND,
    taskId: watch.taskId,
    actorConversationId: null,
    summary:
      "Nothing runs in this subtree any more: no agent is busy and no armed task can launch.",
    payload: {},
  });
  return "became-quiet";
}
