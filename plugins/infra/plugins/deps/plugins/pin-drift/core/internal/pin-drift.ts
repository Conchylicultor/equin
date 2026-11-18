import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/** One install of a pinned dependency: its identity, and its version when its source reads one. */
const InstallSchema = z.object({
  identity: z.string(),
  version: z.string().nullable(),
});
export type PinnedInstallView = z.infer<typeof InstallSchema>;

/**
 * Where one pinned dependency stands against main's checkout — the infra/deps
 * engine's `PinStatus`, as data:
 *
 * - `unpinned` — nothing pinned yet: the daemon's next fresh start pins the
 *   install main's checkout declares.
 * - `pinned` — the pinned install; `running`, the one the live daemon was
 *   started from when that is another (the pin moved since, taking effect at
 *   `appliesAt`); and what main declares: the same, another (`blocked` saying
 *   why it is not a plain switch — a Postgres major), or unreadable.
 */
const PinStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unpinned") }),
  z.object({
    kind: z.literal("pinned"),
    pinned: InstallSchema,
    running: InstallSchema.nullable(),
    declared: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("same") }),
      z.object({
        kind: z.literal("differs"),
        install: InstallSchema,
        blocked: z.string().nullable(),
      }),
      z.object({ kind: z.literal("failed"), message: z.string() }),
    ]),
  }),
]);

export const PinnedDepRowSchema = z.object({
  id: z.string(),
  description: z.string(),
  /** When a moved pin takes effect ("the cluster's next full restart"). */
  appliesAt: z.string(),
  status: PinStatusSchema,
});
export type PinnedDepRow = z.infer<typeof PinnedDepRowSchema>;

/**
 * Every pinned dependency against main's checkout (`mainRoot`, where the
 * daemons' start scripts run and where `./equin deps pin` switches them);
 * not applicable on a release (its bundle sealed the binaries) or a checkout
 * declaring no pin; unreadable when the check itself failed.
 */
export const PinDriftSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("checked"),
    mainRoot: z.string(),
    rows: wholeList(PinnedDepRowSchema, {
      reason:
        "one row per dependency declaring a pin — the host daemons' binaries, a closed handful",
    }),
  }),
  z.object({ kind: z.literal("not-applicable"), reason: z.string() }),
  z.object({ kind: z.literal("unreadable"), message: z.string() }),
]);
export type PinDrift = z.infer<typeof PinDriftSchema>;

/**
 * The pinned dependencies against main, pushed whenever the answer changes.
 * It reads the computer's deps cache and main's checkout (`needsMachine`): a
 * reader under an in-browser server gets `unavailable`.
 */
export const pinDrift = liveValue("deps.pin-drift", {
  schema: PinDriftSchema,
  needsMachine: { feature: "Checking pinned binaries" },
});

/** The command that moves `id`'s pin to what main declares, run in main's checkout. */
export function pinSwitchCommand(mainRoot: string, id: string): string {
  return `cd ${mainRoot} && ./equin deps pin ${id}`;
}
