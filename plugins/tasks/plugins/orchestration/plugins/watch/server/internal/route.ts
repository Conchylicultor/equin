import type { DbExecutor } from "@plugins/database/server";
import {
  watchEventIdKind,
  type WatchEventInput,
  type WatchId,
} from "../../core";
import { nearestLiveWatch } from "./queries";
import { _watchInbox } from "./tables";

/**
 * Route each event to the nearest live watch above its task (the task's own
 * first), never to a watch its actor owns, and record it in that watch's
 * inbox. An event no live watch covers is dropped — the ancestors still see
 * it in their digest. Returns the watches that got something.
 */
export async function routeEvents(
  exec: DbExecutor,
  events: readonly WatchEventInput[],
): Promise<Set<WatchId>> {
  const routed = new Set<WatchId>();
  for (const e of events) {
    const watch = await nearestLiveWatch(
      exec,
      e.taskId,
      e.actorConversationId ?? null,
    );
    if (watch === null) continue;
    await exec.insert(_watchInbox).values({
      id: watchEventIdKind.mint(),
      watchId: watch.id,
      kind: e.kind,
      taskId: e.taskId,
      actorConversationId: e.actorConversationId ?? null,
      summary: e.summary,
      payload: e.payload ?? {},
    });
    routed.add(watch.id);
  }
  return routed;
}
