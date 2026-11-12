import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { WarmupHost } from "@plugins/infra/plugins/warmup/server";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";

export default {
  description:
    "Warm-ups, desktop-only half: provides the WarmupHost host service for a machine shared by many worktree backends — a host-scoped warm-up runs on main only, every one takes the host-wide heavy-read slot (withHeavyReadSlot, reentrant, so a warm-up that reads through a slotted helper does not deadlock), and a derivedFrom warm-up's code digest is source-digest's.",
  contributions: [
    WarmupHost.provide({
      runs: (scope) => scope === "worktree" || isMain(),
      withSlot: withHeavyReadSlot,
      // The checkout's code is on disk: a derivedFrom warm-up runs once per
      // change of the code it derives with (source-digest).
      codeDigest: (sets) => sourceDigest(sets),
    }),
  ],
} satisfies MachinePluginDefinition;
