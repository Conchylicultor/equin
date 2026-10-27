import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { OwnedNamespaceSchema } from "./endpoints";

export const ServeOwnedSchema = z.object({
  namespaces: wholeList(OwnedNamespaceSchema, {
    reason:
      "one per checkout that has served this composition — the delete confirmation names every one it will erase",
  }),
});
export type ServeOwned = z.infer<typeof ServeOwnedSchema>;

/**
 * What does this composition own? A marker scan over EVERY namespace on the
 * host, deliberately not scoped to the answering backend's checkout: a
 * composition served from main and from three worktrees occupies four
 * namespaces, four databases and four config dirs, and deleting its manifest
 * row strands all four. (`resetCompositionData` is the opposite — it acts on
 * the one namespace this checkout serves — and that difference is the whole
 * reason this is a separate value rather than a field of `build.serve-status`.)
 *
 * All the data lives in the shared `~/.equin/` tree, so one backend can
 * answer for — and reclaim — namespaces composed by other checkouts.
 *
 * Read by the delete action with `useLiveReader` at the click: a snapshot,
 * measured when asked (a readdir plus one marker read and one `pg_database`
 * lookup per namespace), so the confirmation names what is there NOW.
 *
 * `composition` is the manifest item's **id**. No id is refused: asking what
 * a never-servable id owns has an honest answer — nothing, since no serve
 * build ever wrote a marker naming it.
 *
 * Desktop-only: the markers are files on the computer.
 */
export const serveOwned = liveValue("build.serve-owned", {
  schema: ServeOwnedSchema,
  params: ["composition"],
  load: "snapshot",
  needsMachine: { feature: "Reading what a composition serves" },
});
