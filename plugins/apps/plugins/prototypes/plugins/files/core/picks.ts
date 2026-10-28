import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeKeyedRecord } from "@plugins/packages/plugins/list-bound/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { isOptionName, isPickValue } from "./options";

// The wire half of a prototype's option picks: which variant of each option
// the user has picked, ONE record per prototype, shared by every surface that
// shows it (main, every worktree deploy, every browser). The store itself — a
// JSON file per prototype under the data dir's `_picks/` — is Node-only and
// lives in `shared/picks.ts`; this is what the browser reads and writes.
//
// Design: `research/2026-09-16-global-shared-prototype-option-picks.md`.

/**
 * The picks as STORED, keyed by option name — raw: checked against the token
 * grammar (`isOptionName` / `isPickValue`: a value token, or a color option's
 * lowercase `#rrggbb`), never against a declaration. A
 * pick can target an option only a recorded version declares, so the live
 * page's options cannot judge it. Every read still goes through
 * `resolvePicks`, which keeps the picks the document on screen declares and
 * drops the rest.
 */
export type StoredPicks = Readonly<Record<string, string>>;

const OptionNameSchema = z
  .string()
  .refine(
    isOptionName,
    "not an option name (lowercase letters, digits and dashes, starting with a letter; `v` is reserved)",
  );
const PickValueSchema = z
  .string()
  .refine(
    isPickValue,
    "not an option value (lowercase letters, digits and dashes, or a lowercase #rrggbb color)",
  );

export const StoredPicksSchema = wholeKeyedRecord(
  OptionNameSchema,
  PickValueSchema,
  { reason: "one pick per option one prototype declares — a handful" },
) satisfies z.ZodType<StoredPicks>;

/**
 * One change to a prototype's picks. One change, never the whole record: two
 * surfaces picking different options at once must not overwrite each other.
 *
 * - `set` — pick `value` for `option` (the other options keep theirs).
 * - `reset` — forget every pick; the page shows its authored defaults.
 */
export const PicksChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set"),
    option: OptionNameSchema,
    value: PickValueSchema,
  }),
  z.object({ kind: z.literal("reset") }),
]);
export type PicksChange = z.infer<typeof PicksChangeSchema>;

/** `picks` with `change` applied — the one fold, shared by the store and the optimistic overlay. */
export function applyPicksChange(
  picks: StoredPicks,
  change: PicksChange,
): StoredPicks {
  return change.kind === "reset"
    ? {}
    : { ...picks, [change.option]: change.value };
}

/**
 * One prototype's stored picks — a live value per `name`, one small record per
 * subscription. Served from the file store (`source: "external"`), notified by
 * the writer the moment it writes and by the watcher on every other backend
 * (the store is host-global). `{}` is "nothing picked", a legitimate answer
 * once loaded — and never a stand-in before: until the record is read the value
 * is pending. A name that is not a prototype throws.
 */
export const prototypePicks = liveValue("prototypes.picks", {
  schema: StoredPicksSchema,
  params: ["name"],
});

/**
 * Apply one change to a prototype's picks. 404 for an unknown prototype. An
 * automated browser session's change is recorded in the agent-write ledger and
 * put back at the end of its run, so an E2E that clicks the picker never leaves
 * the user looking at another variant.
 */
export const setPrototypePicks = defineEndpoint({
  route: "PUT /api/prototypes/:name/picks",
  agentReverted: true,
  body: PicksChangeSchema,
});
