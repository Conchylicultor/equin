/**
 * What a push does with its fix claims once the branch is in landing shape.
 *
 * A fix claim is a trailer, and a trailer reaches main only on a commit this
 * push lands. A push naming a report but landing NO commit (a clean tree
 * already equal to main, or every commit dropped by the rebase as already
 * upstream) used to run every check, print "Done", and land nothing — the claim
 * silently dropped in exactly the case `--report-fixed-by` exists for.
 *
 * - `rides` — the push lands commits (or claims nothing): the trailers ride
 *   them, as before.
 * - `commit` — `--report-fixed-by` only: the claim IS the push (the fix is an
 *   earlier commit already on main), so it gets a commit of its own — empty,
 *   with the push's `-m` and every landing trailer.
 * - `refuse` — `--fixes-report` says THIS push is the fix, and a push landing
 *   nothing fixes nothing; or the claim needs its own commit and there is no
 *   `-m` to write it with.
 */
export type FixClaimCarrier =
  | { kind: "rides" }
  | { kind: "commit"; message: string; announce: string }
  | { kind: "refuse"; message: string };

export function fixClaimCarrier(input: {
  /** Commits this push lands, counted after its last rebase. */
  landed: number;
  /** Reports named by `--fixes-report` / `--report-fixed-by`. */
  fixed: { fixes: readonly string[]; fixedBy: readonly string[] };
  message: string | undefined;
}): FixClaimCarrier {
  const { landed, fixed } = input;
  if (landed > 0) return { kind: "rides" };
  if (fixed.fixes.length === 0 && fixed.fixedBy.length === 0)
    return { kind: "rides" };
  if (fixed.fixes.length > 0) {
    return {
      kind: "refuse",
      message: [
        `--fixes-report ${fixed.fixes.join(", ")}: this push lands no commit, so it cannot be the fix. Nothing was pushed.`,
        ``,
        `If an earlier commit on main fixed it, claim that commit instead:`,
        `  ./equin push --report-fixed-by <report-id>@<sha> -m "…"`,
      ].join("\n"),
    };
  }
  if (input.message === undefined || input.message.trim() === "") {
    return {
      kind: "refuse",
      message: [
        `--report-fixed-by ${fixed.fixedBy.join(", ")}: this push lands no commit, so the claim needs one of its own. Nothing was pushed.`,
        ``,
        `Re-run with -m "<why that commit fixed the report>" — push makes an empty commit carrying the claim.`,
      ].join("\n"),
    };
  }
  return {
    kind: "commit",
    message: input.message,
    announce: `No commit to land — committing the fix claim for ${fixed.fixedBy.join(", ")} on its own (empty commit).`,
  };
}
