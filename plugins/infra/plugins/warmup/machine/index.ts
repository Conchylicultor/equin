import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  heavyReadLocalSlotCount,
  withHeavyReadSlot,
} from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { WarmupHost } from "@plugins/infra/plugins/warmup/server";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";

export default {
  description:
    "Warm-ups, desktop-only half: provides the WarmupHost host service for a machine shared by many worktree backends — a host-scoped warm-up runs on main only, every one takes the host-wide heavy-read slot (withHeavyReadSlot, reentrant, so a warm-up that reads through a slotted helper does not deadlock) and at most one fewer run at once than the backend's heavy-read slots, so interactive git reads always have one, and a derivedFrom warm-up's code digest is source-digest's.",
  contributions: [
    WarmupHost.provide({
      runs: (scope) => scope === "worktree" || isMain(),
      withSlot: withHeavyReadSlot,
      // One slot fewer than this backend's heavy-read gate: the drain runs as
      // every tab resubscribes after a restart, and a drain holding the whole
      // gate made edited-files' git pass queue behind whole warm-up bodies
      // (main, 2026-11-16 15:25: 1.6 s on heavy-read-local behind
      // config-orphans.stranded + prototype-thumbnails.sync, its tabs' update
      // 2.0 s late — `wait flush-queue`). A one-slot gate has nothing to spare.
      concurrency: () => Math.max(1, heavyReadLocalSlotCount() - 1),
      // The checkout's code is on disk: a derivedFrom warm-up runs once per
      // change of the code it derives with (source-digest).
      codeDigest: (sets) => sourceDigest(sets),
    }),
  ],
} satisfies MachinePluginDefinition;
