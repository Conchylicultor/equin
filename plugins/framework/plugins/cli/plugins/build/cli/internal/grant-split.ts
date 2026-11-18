/**
 * How many of a build's grant units its check pass reserves while it runs
 * beside the frontend: half, rounded up. The check child is handed exactly
 * that share (`grant.run`'s `share.env()`), and the frontend's artifact
 * pipeline gets the rest ({@link frontendUnits}).
 *
 * The two used to share every unit: the check child inherited the whole grant
 * while the pipeline spent the same units in this process, so a build ran
 * twice the work its admission paid for. On an 8 GB host (`B = 1`) that put
 * the cold check pass's type-check fleet (its batch processes up to 5.5 GB)
 * beside the pipeline's in-process rolldown link (orchestrator 3.7 GB), and
 * the kernel killed the check pass (2026-11-18). Now a one-unit build runs its
 * checks, then its frontend; from two units up they still overlap, each in
 * its own share.
 */
export function checkPassUnits(units: number): number {
  return Math.ceil(units / 2);
}

/**
 * The frontend's units: the whole grant when nothing validates beside it (a
 * first main deploy), else what {@link checkPassUnits} leaves — at least one,
 * which on a one-unit grant waits for the check pass to hand it back.
 */
export function frontendUnits(units: number, withChecks: boolean): number {
  return withChecks ? Math.max(1, units - checkPassUnits(units)) : units;
}
