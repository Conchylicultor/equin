import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { Check } from "@plugins/framework/plugins/tooling/core";

// A check pass holds memory two ways. Its heavy CHILDREN — type-check's
// worker and batches, the layout suite's Vite build and Chromium, live's
// fixture compile — are admitted by the grant: each `ctx.grant.run` spends a
// unit, a quantum of host memory (`PER_UNIT_BYTES`). The pass's OWN process is
// admitted by nothing: every in-process check runs in it, and it keeps what
// they built until it exits — 3.2 GB on a cold pass even one check at a time
// (`--jobs 1`), 1.7 GB warm (8 GB Ubuntu VM, 2026-11-18). On a grant of one
// unit the two must not overlap: on that VM a cold type-check batch beside the
// in-process checks was ~8 GB, and the kernel killed the pass on every deploy
// of main (research/2026-11-19-global-8gb-deploy-check-pass-memory.md).

/**
 * The order a pass runs its checks in. On a grant of more than one unit every
 * check starts at once (the gate's width permitting), as before. On a grant of
 * ONE unit, the checks that spend the grant (`heavyChildren`) run first, one at
 * a time, and every other check waits for them: the pass's own process is still
 * small while the heavy children run, and they are gone when it grows.
 *
 * Heavy FIRST, not last: what the in-process checks build stays resident after
 * they finish (Bun returns a page only once it is empty), so a heavy child
 * started after them runs beside all of it.
 */
export function passPhases<C extends Pick<Check, "heavyChildren">>(
  selected: readonly C[],
  grantUnits: number,
): { first: readonly C[]; rest: readonly C[] } {
  if (grantUnits > 1) return { first: [], rest: selected };
  return {
    first: selected.filter((c) => c.heavyChildren !== undefined),
    rest: selected.filter((c) => c.heavyChildren === undefined),
  };
}

/**
 * The grant a check's context carries: the run's own for a check that
 * declares `heavyChildren`; for any other, the same units and lane with a
 * `run` that throws, naming the check. A heavy child spawned by a check that
 * does not say so would run beside the in-process checks on a one-unit grant
 * — the overlap `passPhases` exists to prevent — so it fails loudly instead.
 */
export function grantFor(
  check: Pick<Check, "id" | "heavyChildren">,
  grant: Grant,
): Grant {
  if (check.heavyChildren !== undefined) return grant;
  return {
    units: grant.units,
    lane: grant.lane,
    run() {
      return Promise.reject(
        new Error(
          `check "${check.id}" spent ctx.grant without declaring heavyChildren: a check that runs heavy children on the grant declares it (Check.heavyChildren), so a one-unit pass can run it before the in-process checks instead of beside them`,
        ),
      );
    },
  };
}
