import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * A build run's id (`build_runs.id`), declared once (`plugins/ids`) in the
 * ledger leaf that owns the table — so both minters, the backend's claim
 * (`build/server`) and a hand-run `./equin build` (the CLI, which can
 * import this core and nothing heavy), mint the same shape.
 *
 * Live rows carry two older shapes: `build-<ms>-<≤6>` (the backend's) and
 * `<shortCommit>-<ms>` (a hand-run build's, before it minted through the
 * kind). The first is still recognised; the second never was an id of any
 * kind and stays an opaque key.
 */
export const buildRunIdKind = defineIdKind({ prefix: "build", label: "Build" });

export type BuildRunId = IdOf<typeof buildRunIdKind>;
