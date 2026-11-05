import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { writeBootReadyEvent } from "./internal/write-boot-event";

export { readBootEvents } from "./internal/read-boot-events";
export { readBootJournals } from "./internal/boot-journal";
export {
  writeBootDeadEvent,
  writeBootStartEvent,
} from "./internal/write-boot-event";
export type { BootJournalSummary } from "./internal/boot-journal";
export { BootLineSchema } from "./internal/schema";
export type { BootEvent, BootLine } from "./internal/schema";

export default {
  description:
    "Durable per-boot event lines: a `start` line as the serving process starts, before its plugin imports (so a backend wedged during migrations/boot is visible as an open-ended bar) and a `ready` line from the onReady hook, paired by processStartedAt into the wall-clock interval readBootEvents(worktree, windowMs) returns — so deploy-restart bursts render on cross-worktree timelines, with no DB table (survives re-forks, readable while a backend is wedged).",
  onReady: () => {
    writeBootReadyEvent();
  },
} satisfies ServerPluginDefinition;
