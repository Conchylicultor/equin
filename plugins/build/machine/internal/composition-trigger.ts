import {
  resolved,
  unresolved,
} from "@plugins/primitives/plugins/live-state/core";
import { autoRebuildIntervalMs } from "@plugins/plugin-meta/plugins/composition/core";
import { wantsBuild } from "@plugins/build/plugins/deployment/core";
import type { BuildAttempt } from "@plugins/build/plugins/deployment/core";

/**
 * Everything the rebuild question is asked about, as plain data.
 *
 * `mode` is the manifest row's stored `serve` — a `string`, because that is what
 * the config field's value type is; `autoRebuildIntervalMs` narrows it and
 * throws on anything outside the union.
 *
 * `marker` is the `composition.json` this namespace carries, or `null` when
 * NOTHING is served there. The two are genuinely different states, which is why
 * this is nullable rather than a marker with empty fields: see the never-mint
 * clause below.
 */
export interface CompositionRebuildInputs {
  mode: string;
  marker: { commit?: string | null; builtAt: string } | null;
  /** This checkout's HEAD — the target the composition converges toward. */
  head: string | null;
  lastAttempt: BuildAttempt | null;
  now: Date;
}

/**
 * Should an automatic edge rebuild this composition right now?
 *
 * Pure, for the reason `derive.ts` is pure: the properties this loop rests on
 * have to be decidable — and testable — with no db / config / git singleton in
 * reach. The bound half (which manifest rows exist, which namespace each
 * resolves to, what the ledger says) is `decideBuilds`, next door.
 *
 * `server/internal/` rather than `core/`, unlike `derive.ts`: nothing web-facing
 * asks this question, and `core/` is external to the `web` artifact — putting it
 * on that barrel would route the compositions manifest it imports into
 * `build/web`'s chunk for a predicate the browser never runs.
 *
 * A trigger mode adds exactly ONE thing to main's own auto-build policy: a rate
 * limit. Everything else is delegated to `wantsBuild`, so a served composition
 * inherits the same guarantees, already unit-tested next door:
 *
 * - **converged ⇒ no build** — the marker's commit is this checkout's HEAD.
 * - **termination** — a target already attempted, ok OR failed, is not
 *   re-attempted, so a composition that cannot build does not rebuild for ever.
 *   That is why there is no second termination clause here; adding one would be
 *   a competing spelling of the property, which is how the 2026-08-19 incident
 *   started.
 *
 * The arms below run in this order, and the order is the content:
 */
export function compositionWantsRebuild(i: CompositionRebuildInputs): boolean {
  // 1. A mode that is never automatic. `off` is not served at all and `manual`
  //    is served but hand-driven; both say "no edge may act", which is a
  //    different statement from "not due yet" — the `null` vs `0` distinction
  //    `AUTO_REBUILD_INTERVAL_MS` exists to keep unspellable.
  const intervalMs = autoRebuildIntervalMs(i.mode);
  if (intervalMs === null) return false;

  // 2. Nothing is served at this namespace. An automatic trigger must never
  //    MINT one: claiming a namespace provisions a gateway registry dir, a
  //    database and a spec dir, and the one thing that may do that is a human
  //    pressing Serve. A guard, not an optimisation — without it, switching a
  //    never-served composition to `push` would silently stand up an app
  //    nobody asked to exist.
  if (i.marker === null) return false;

  // 3. The rate limit — the whole content of a mode. Measured from the last
  //    build's own recorded instant, so a cadence cannot drift with how often
  //    the edges happen to fire.
  //
  //    An unparseable `builtAt` (NaN) means the limit CANNOT be applied, and
  //    the honest reading of that is "due": treating it as not-due would strand
  //    the composition for ever with no way back, since nothing rewrites a
  //    marker except the build this clause is refusing. The convergence clause
  //    below still gates it, so at worst this costs one build that the commit
  //    comparison then declines to repeat.
  const builtAtMs = Date.parse(i.marker.builtAt);
  if (!Number.isNaN(builtAtMs) && i.now.getTime() - builtAtMs < intervalMs)
    return false;

  // 4. No target to converge toward — the arm `wantsBuild` opens with, stated
  //    here too because the marker-as-carrier below needs a resolved head.
  if (i.head === null) return false;

  // 5. The SAME policy main's own auto-build runs, over a deployment whose one
  //    deployable carrier IS the marker. The composition's namespace serves a
  //    dist and runs a server tree that the composing build materialized
  //    together from one commit, so `web` is the honest carrier id for it.
  return wantsBuild(
    {
      target: resolved(i.head),
      deployable: [
        {
          id: "web",
          // A marker written before the `commit` field genuinely cannot name
          // one. `convergenceOf` reads an unresolved pin as `behind`, never as
          // converged, so such a namespace builds exactly once and then
          // self-heals — the marker the build stamps carries a commit.
          commit:
            i.marker.commit == null
              ? unresolved("this composition.json predates the commit field")
              : resolved(i.marker.commit),
          // Determinate absences, NOT read failures. We do not read another
          // namespace's dist graph, and we do not pay a `merge-base
          // --is-ancestor` git spawn per served composition on every edge —
          // and the edges include a quarter-hourly tick that usually decides
          // nothing. Both are exact rather than lossy: `convergenceOf` compares
          // only `commit` on its converged arm, and only trips `diverged` on a
          // RESOLVED `false`, so an unresolved `ancestorOfTarget` cannot turn a
          // converged namespace into a build.
          graph: unresolved("a composition's dist graph is not read from here"),
          ancestorOfTarget: unresolved(
            "not probed — that is a git spawn per served composition per edge",
          ),
        },
      ],
    },
    i.lastAttempt,
  );
}
