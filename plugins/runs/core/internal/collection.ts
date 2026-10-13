import { z } from "zod";
import { armKeyCodec } from "@plugins/infra/plugins/query-resource/core";
import {
  liveCollection,
  type WithContributedColumns,
} from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  RUN_OUTCOMES,
  RunOutcomeSchema,
} from "@plugins/runs/plugins/run-outcome/core";

/**
 * One row of the merged run space — the BASE fields, the ones every run kind
 * projects and therefore the only ones a filter, a sort or a group-by can mean
 * the same thing by across kinds. An arm's own fields (a build's exit code, a
 * backup's archive size) ride its rows under `$columns[<kind>]`, declared by
 * the arm (`liveArmColumns(runs, kind, …)`) and read through its handle.
 *
 * A NULL base field is a real answer, not a gap: a backup is host-global and
 * a deploy targets a remote box, so neither has a `namespace`.
 */
export const RunRowSchema = z.object({
  /** The union row key `kind:id` — unique across ledgers (`runRowKey`). */
  runKey: z.string(),
  /** Which arm this row came from — the discriminator. */
  kind: z.string(),
  /** The row's id **within its own ledger**; unique only per kind. */
  id: z.string(),
  /** What this run was *of*, in the kind's own words — the row's title. */
  label: z.string(),
  /** The shared status axis. See `run-outcome`. */
  outcome: RunOutcomeSchema,
  /** What set it off (a person, a schedule, another run). Null when unrecorded. */
  trigger: z.string().nullable(),
  startedAt: z.coerce.date(),
  /** Null exactly while the run is in flight. */
  finishedAt: z.coerce.date().nullable(),
  /**
   * Wall-clock milliseconds, `finishedAt − startedAt` — DERIVED by
   * `defineRunKind`, never supplied by an arm, and NULL while the run is in
   * flight (a running run's elapsed time is the browser's ticker,
   * `<RunDuration>`, not a value the server would have to re-push every
   * second).
   */
  duration: z.number().nullable(),
  /** The worktree this run belongs to, where the kind has such a notion. */
  namespace: z.string().nullable(),
  /** The failure's own words, kept verbatim. Null on a run with nothing to say. */
  message: z.string().nullable(),
});

/**
 * **runs** — every long-running operation on this machine, from every ledger,
 * as ONE routed union window (P6 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md). Each run kind
 * is an arm (`defineRunKind`, server), served from its own table; a write to
 * one ledger refills only the rows it changed, in the windows reading that arm.
 *
 * Newest first by default; read as key-range pages, so the list pages past
 * one window.
 */
export const runs = liveCollection("runs", {
  row: RunRowSchema,
  id: "runKey",
  arms: { discriminator: "kind" },
  filterable: {
    kind: liveText(),
    label: liveText(),
    outcome: liveText(z.enum(RUN_OUTCOMES)),
    trigger: liveText(),
    namespace: liveText(),
    message: liveText(),
    startedAt: liveInstant(),
    finishedAt: liveInstant(),
    duration: liveNumber(),
  },
  sortable: [
    "kind",
    "label",
    "outcome",
    "trigger",
    "namespace",
    "startedAt",
    "finishedAt",
    "duration",
  ],
  default: { orderBy: [["startedAt", "desc"]], limit: 50 },
  maxLimit: 200,
});

/** One row of the merged run space, with its arm's own columns under `$columns`. */
export type RunRow = WithContributedColumns<z.infer<typeof RunRowSchema>>;

/**
 * The row key for the merged space: `kind:id` (`armKeyCodec`, the same codec
 * the server's routes encode with and its SQL projects).
 *
 * Takes the PAIR rather than a whole run, so a caller holding a domain id (the
 * build detail pane knowing which build run is open) can name a row without
 * inventing one. A bare id is not a thing that can be spelled: two ledgers can
 * mint the same id.
 */
export function runRowKey(ref: { kind: string; id: string }): string {
  return armKeyCodec(ref.kind).encode(ref.id);
}
