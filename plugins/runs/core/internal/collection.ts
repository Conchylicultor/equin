import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { armKeyCodec } from "@plugins/infra/plugins/query-resource/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  RUN_OUTCOMES,
  RUN_OUTCOME_OPTIONS_META,
} from "@plugins/runs/plugins/run-outcome/core";

/**
 * The BASE fields of the merged run space — the ones every run kind projects
 * and therefore the only ones a filter, a sort or a group-by can mean the same
 * thing by across kinds — in list order. An arm's own fields (a build's exit
 * code, a backup's archive size) ride its rows under `$columns[<kind>]`,
 * declared by the arm (`liveArm(runs, kind, { label, fields })`) and read
 * through it.
 *
 * A NULL base field is a real answer, not a gap: a backup is host-global and
 * a deploy targets a remote box, so neither has a `namespace`.
 */
const runFields = {
  /** What this run was *of*, in the kind's own words — the row's title. */
  label: textField({ label: "Run", primary: true }),
  /** Which arm this row came from — the discriminator. */
  kind: textField({ label: "Kind" }),
  /** The shared status axis. See `run-outcome`. */
  outcome: enumTextField(RUN_OUTCOMES, {
    label: "Outcome",
    options: RUN_OUTCOME_OPTIONS_META,
  }),
  /** What set it off (a person, a schedule, another run). Null when unrecorded. */
  trigger: nullable(textField({ label: "Trigger" })),
  /** The worktree this run belongs to, where the kind has such a notion. */
  namespace: nullable(textField({ label: "Namespace" })),
  /**
   * Wall-clock milliseconds, `finishedAt − startedAt` — DERIVED by
   * `defineRunKind`, never supplied by an arm, and NULL while the run is in
   * flight (a running run's elapsed time is the browser's ticker,
   * `<RunDuration>`, not a value the server would have to re-push every
   * second).
   */
  duration: nullable(floatField({ label: "Took" })),
  startedAt: dateField({ label: "Started" }),
  /** Null exactly while the run is in flight. */
  finishedAt: nullable(dateField({ label: "Finished" })),
  /** The failure's own words, kept verbatim. Null on a run with nothing to say. */
  message: nullable(textField({ label: "Message" })),
};

/**
 * **runs** — every long-running operation on this machine, from every ledger,
 * as ONE routed union window (P6 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md). Each run kind
 * is an arm (`defineRunKind`, server), served from its own table; a write to
 * one ledger refills only the rows it changed, in the windows reading that arm.
 *
 * Its base fields are its own (`fields`), presented once in `runs/web`
 * (`FieldPresentation.Register({ owner: runs })`); every listed one filters.
 * Newest first by default; read as key-range pages, so the list pages past
 * one window.
 */
export const runs = liveCollection("runs", {
  fields: runFields,
  carry: {
    fields: {
      /** The union row key `kind:id` — unique across ledgers (`runRowKey`). */
      runKey: textField(),
      /** The row's id **within its own ledger**; unique only per kind. */
      id: textField(),
    },
  },
  id: "runKey",
  arms: { discriminator: "kind" },
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

/** The row schema of the merged run space (base fields, the union key, the ledger id). */
export const RunRowSchema = runs.row;

/** One row of the merged run space, with its arm's own fields under `$columns`. */
export type RunRow =
  typeof runs extends LiveRowsCollection<infer R> ? R : never;

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

/**
 * The task subject (`tasks/task-subject`) a run's investigation is filed
 * about — the ONE spelling, so the merged list, the run's own detail pane and
 * any other surface investigating the same run reach the same task. Takes the
 * pair, like `runRowKey`.
 */
export function runSubject(ref: { kind: string; id: string }): {
  kind: string;
  id: string;
} {
  return { kind: `run:${ref.kind}`, id: ref.id };
}
