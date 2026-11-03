import { serveUnionCollection } from "@plugins/network/plugins/live/server";
import { runs } from "../../core";

/**
 * The merged run space, served: every run kind is one arm of the `runs`
 * union window, bound by its own plugin through `runsServed.arm(arm, { from,
 * id, base, extra, where? })` — `runs` never names one, and adding a kind is
 * one folder. Two base fields are the union's own, so no arm supplies them and
 * no two arms can disagree about what they are:
 *
 * - `id` — the row's id within its own ledger: the arm's primary key;
 * - `duration` — a clock field (`clockField.elapsed`, declared in core),
 *   derived for every arm from `startedAt` / `finishedAt` (which every arm
 *   therefore binds to columns) against the tuple's pinned `now`.
 */
export const runsServed = serveUnionCollection(runs, {
  derive: {
    id: { reads: [], bind: (_reads, { id }) => id },
  },
});
