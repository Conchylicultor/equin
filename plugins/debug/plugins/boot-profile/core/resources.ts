import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { SavedBootTraceSchema } from "./fields";

/** One saved snapshot's metadata — the list's row, with no snapshot blob. */
const BootTraceItemSchema = z.object({
  id: z.string(),
  worktree: z.string(),
  createdAt: z.coerce.date(),
});
export type BootTraceItem = z.infer<typeof BootTraceItemSchema>;

/**
 * The saved boot traces (`boot_traces`), newest first, as the Boot Profiles
 * browse pane's live source. The row is the metadata projection — the server
 * projects exactly these keys, so the snapshot blob never rides the list. A
 * scroll window (100 a page); a save (Copy permalink) or the 30-day retention
 * sweep reaches it through the change feed.
 */
export const bootTraces = liveCollection("debug.boot-traces", {
  row: BootTraceItemSchema,
  id: "id",
  filterable: { worktree: liveText(), createdAt: liveInstant() },
  sortable: ["createdAt", "worktree"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
  scroll: true,
});

/**
 * One saved boot trace with its full snapshot, read by id (`useLiveRow`) for
 * the permalink detail pane: a lookup-only collection over the same table, so
 * `found: false` is "no such snapshot".
 */
export const bootTrace = liveCollection("debug.boot-trace", {
  row: SavedBootTraceSchema,
  id: "id",
});
