import { and, eq, isNull, ne } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import { QUIET_EVENT_KIND, watchEventIdKind, type WatchId } from "../../core";
import { getWatch, isWatchLive, subtreeActive } from "./queries";
import { _taskWatches, _watchInbox } from "./tables";

export type QuietOutcome =
  | "not-live"
  | "unchanged"
  /** Flipped to busy: a `quiet` event not delivered yet is withdrawn. */
  | "became-busy"
  /** Flipped to quiet: a `quiet` event is in the watch's inbox. */
  | "became-quiet";

/**
 * Re-evaluate whether a watch's subtree is quiet and record a flip. Only a
 * false → true flip raises a `quiet` event (once per transition). A true →
 * false flip withdraws that event while it is still undelivered: `quiet` is a
 * claim about the present, and a watcher is held (busy, asking the user) for
 * as long as it takes — an agent launched meanwhile (still `starting`) would
 * otherwise be told its subtree is idle. Its settling flips it back and raises
 * a fresh one. The watcher's own conversation never counts as activity — a
 * watcher on its own subtree is not kept busy by itself.
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
  if (!quiet) {
    await exec
      .delete(_watchInbox)
      .where(
        and(
          eq(_watchInbox.watchId, watchId),
          eq(_watchInbox.kind, QUIET_EVENT_KIND),
          isNull(_watchInbox.deliveredInTurn),
        ),
      );
    return "became-busy";
  }
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
