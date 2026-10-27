import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { PrototypeHistoryStore } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { openSnapshotHistoryStore } from "./internal/snapshot-store";

export default {
  description:
    "Prototype version history for a host without the computer (the browser composition): provides the PrototypeHistoryStore host service as content-addressed snapshots over the prototypesFiles root — per prototype a log of versions, each file's bytes stored once by sha256, and the same latest.json stamp the tree's watch turns into a notify. Never booted by the desktop, whose history is git.",
  portable: true,
  contributions: [
    PrototypeHistoryStore.provide(openSnapshotHistoryStore(prototypesFiles)),
  ],
} satisfies ServerPluginDefinition;
