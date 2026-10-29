import type { WatchRow } from "@plugins/tasks/plugins/orchestration/plugins/watch/server";

/** The automation a code watch was opened for: its `key`. An automation's
 * handlers only ever open code watches, so any other watcher is a broken
 * routing invariant, not a case to skip. */
export function watchingAutomationId(watch: WatchRow): string {
  if (watch.watcher.kind !== "code")
    throw new Error(
      `[automations] watch ${watch.id} reached an automation handler but is watched by ${watch.watcher.kind}`,
    );
  return watch.watcher.key;
}
