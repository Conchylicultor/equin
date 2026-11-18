import { z } from "zod";
import {
  resolvableSchema,
  type Resolvable,
} from "@plugins/network/plugins/live/plugins/live-state/core";
import { CommitRowSchema } from "@plugins/primitives/plugins/commit-list/core";

/**
 * A **carrier** is a thing that executes repo code and can name the commit it
 * was materialized from. There are three, and everything about deployment
 * freshness is derived from them:
 *
 * - `server` — this backend process, pinned to the tree its plugin graph was
 *   imported from.
 * - `web` — the frontend bundle this backend serves, pinned by the `.build-commit`
 *   / `.build-graph` trailers the build stamps into the dist.
 * - `tab` — the bundle one browser tab is actually running, pinned by the globals
 *   baked into it. The server cannot know this one; the client composes it in.
 *
 * `server` and `web` are the DEPLOYABLE carriers — the two a build can move. A
 * stale tab is answered by reloading it, never by building.
 */
export const CARRIER_IDS = ["server", "web", "tab"] as const;
export type CarrierId = (typeof CARRIER_IDS)[number];

export const CarrierIdSchema = z.enum(CARRIER_IDS);

/**
 * Every pin on a carrier is `Resolvable`: a carrier that cannot name its commit
 * says so, and never hands back a fake sha or `""` a consumer could mistake for
 * one. The three reasons this actually happens are all determinate states, not
 * transient read failures:
 *
 * - a release bundle has no checkout, so nothing has a commit at all;
 * - a dist published before the pin existed carries no trailer;
 * - the checkout moved during the plugin-import wave, so the process is a mix of
 *   two trees and NO single commit is honest ("mixed boot").
 *
 * `graph` is the content identity of the composed web module graph. It is
 * `unresolved` on the `server` carrier for a category reason rather than a
 * failure — a server process carries no module graph — which is exactly what the
 * unresolved arm means: the answer is determinate, and it is "there is nothing
 * to determine".
 *
 * `ancestorOfTarget` is git's answer to "is this pin on the line leading to the
 * target?", measured on the server and carried here as a plain fact so the
 * derivations below stay pure and directly testable.
 */
export const CarrierSchema = z.object({
  id: CarrierIdSchema,
  commit: resolvableSchema(z.string()),
  graph: resolvableSchema(z.string()),
  ancestorOfTarget: resolvableSchema(z.boolean()),
});
export type Carrier = z.infer<typeof CarrierSchema>;

/**
 * The raw facts a convergence question is asked about: where this checkout's
 * HEAD is, and where each deployable carrier is. Deliberately NOT the wire
 * payload — the payload below is the ANSWER, this is the input.
 */
export interface Deployment {
  target: Resolvable<string>;
  deployable: Carrier[];
}

/** What `convergenceOf` answers. Also the discriminant of the wire payload. */
export type ConvergenceKind = "converged" | "behind" | "diverged" | "unknown";

/**
 * How many commits a single walk may return.
 *
 * The chain between a carrier and the target is normally the drift of one
 * working session — single digits. But nothing bounds it: a tab left open for a
 * fortnight is hundreds of commits behind, and "how long has this been open" is
 * not a bound. So the walk is capped, and the cap is stated here rather than at
 * the call site, because the client renders the number it stopped at.
 */
export const CHAIN_CAP = 200;

/**
 * A walk between two commits, and whether it reached the far end.
 *
 * `truncated` is carried rather than inferred, because the two ways to end a
 * capped walk look identical from the rows alone — a chain of exactly
 * {@link CHAIN_CAP} commits that happens to end on the carrier's own commit, and
 * one cut short with older commits still below it. A consumer that guessed would
 * be right most of the time, which is the worst kind of wrong: a silently short
 * chain reads as "this is how far behind you are".
 *
 * When `truncated`, the far end's own row is NOT included — the walk never
 * reached it — so the carrier that asked for the chain has no row, and that is
 * a fact the UI states rather than hides.
 */
export const ChainSchema = z.object({
  // At most `CHAIN_CAP` walked commits, plus the base's own row when the walk
  // reached it.
  commits: z.array(CommitRowSchema).max(CHAIN_CAP + 1),
  truncated: z.boolean(),
});
export type Chain = z.infer<typeof ChainSchema>;

/**
 * There was no commit to walk from at all — a fresh checkout with no dist, or a
 * mixed boot on both carriers. Distinct from a walk that returned nothing,
 * which cannot happen: a walk always includes at least the target's own row.
 */
export const NO_CHAIN: Chain = { commits: [], truncated: false };

/**
 * The wire payload: one honest description of what is deployed, from which both
 * the Build button's chain and the auto-build decision are derived — so a wrong
 * badge and a missed rebuild are the same bug.
 *
 * A discriminated union rather than a bag of nullable fields, because the four
 * arms genuinely carry different evidence:
 *
 * - `converged` — every deployable carrier is at `target`. The chain is the walk
 *   from `target` to itself: exactly one row, for HEAD.
 * - `behind` — the chain runs from the oldest deployable pin up to `target`,
 *   inclusive of that pin's own commit so a carrier badge has a row to sit on.
 *   Building this list is git work, which is why it is computed on the server
 *   and shipped rather than re-derived by every consumer.
 *
 * Both answerable-and-on-the-line arms carry a `chain`, and that is deliberate:
 * a converged deployment used to carry a bare `target` sha and no rows, which
 * forced the client to hand-draw a row the normal renderer could not produce.
 * Two ways to draw one row meant two copies of "which carrier goes where", and
 * they drifted. One shape, one renderer.
 * - `diverged` — some carrier sits on a commit that is not an ancestor of
 *   `target` (a rebase or force-push under a running app). There is no line to
 *   draw, so no chain is carried.
 * - `unknown` — there is no `target` to be behind. A release bundle has no
 *   checkout, so the question is genuinely unanswerable; the field is ABSENT on
 *   this arm rather than null, so no consumer can read a target that isn't one.
 *   The carrier pins are still carried — they are facts even when the target is
 *   not.
 */
export const DeploymentStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("converged"),
    target: z.string(),
    deployable: z.array(CarrierSchema).max(CARRIER_IDS.length),
    chain: ChainSchema,
  }),
  z.object({
    kind: z.literal("behind"),
    target: z.string(),
    deployable: z.array(CarrierSchema).max(CARRIER_IDS.length),
    chain: ChainSchema,
  }),
  z.object({
    kind: z.literal("diverged"),
    target: z.string(),
    deployable: z.array(CarrierSchema).max(CARRIER_IDS.length),
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.string(),
    deployable: z.array(CarrierSchema).max(CARRIER_IDS.length),
  }),
]);
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

/**
 * One closed build attempt, read straight off `build_runs` (`id`,
 * `commitHash`, and `exitCode` read as a status) — there is no new storage
 * behind this.
 *
 * `outcome` says whether the attempt is a VERDICT on the code it built:
 *
 * - `ok` / `failed` are. A target whose build gave one is consumed: retrying
 *   a deterministic failure automatically is exactly the loop the termination
 *   clause of {@link wantsBuild} exists to prevent.
 * - `no-verdict` is a build that ended without judging the code — killed by a
 *   signal from outside (the OOM killer, a host shutdown), interrupted (its
 *   process vanished), or superseded. The same commit may be tried again, a
 *   bounded number of times (`MAX_NO_VERDICT_ATTEMPTS`).
 */
export interface BuildAttempt {
  /** The run's id — what its run-detail pane opens. */
  id: string;
  commit: string | null;
  outcome: "ok" | "failed" | "no-verdict";
}

/**
 * How many attempts at ONE commit may end without a verdict before the
 * convergence run stops trying it. Three: one killed build is routinely the
 * host (memory pressure, a sleep), three in a row is something a person has to
 * look at — and each attempt costs a full build.
 */
export const MAX_NO_VERDICT_ATTEMPTS = 3;

/**
 * Why an automatic build is, or is not, wanted — the reason, not just the
 * bit, so the convergence run never says "converged" about a deployment that
 * is not (2026-11-18: a killed and a failed build were both logged as
 * "converged at <sha>: nothing to build" while main served an older commit).
 *
 * - `build` — wanted. `retry` is how many earlier attempts at this commit ended
 *   without a verdict (0 for a first attempt).
 * - `converged` — every deployable carrier is at the target.
 * - `unknown` — nothing to converge toward, or nothing materialized to compare.
 * - `failed` — the target's newest verdict is a failed build: decided, not
 *   retried; the next push (or a manual Build) is the next attempt.
 * - `built` — the target's build passed, yet a carrier is not at it (a mixed
 *   boot): not rebuilt automatically, see {@link wantsBuild}.
 * - `retries-spent` — the target's last {@link MAX_NO_VERDICT_ATTEMPTS}
 *   attempts all ended without a verdict.
 */
export type AutoBuildDecision =
  | { kind: "build"; retry: number }
  | { kind: "converged" }
  | { kind: "unknown" }
  | { kind: "failed"; attempt: BuildAttempt }
  | { kind: "built"; attempt: BuildAttempt }
  | { kind: "retries-spent"; attempts: BuildAttempt[] };

// Git's own shortest unambiguous abbreviation. Below this a prefix match is not
// evidence of anything.
const MIN_ABBREV = 7;

/**
 * Whether two spellings name the same commit, tolerating git's abbreviated form.
 *
 * Tolerance for the PAST, not the mechanism the comparison depends on. Both
 * writers of `build_runs.commitHash` now store the full sha — the backend's
 * `getHeadCommit()` and the CLI's ledger mint, the latter recording the same
 * `headAtStart` it stamps into the dist as `.build-commit`. So a fresh row and a
 * pin are directly comparable.
 *
 * Rows already in the column are not: `commitHash` held `rev-parse --short`
 * output (8–9 chars) against a 40-char pin, and plain `===` between them is
 * silently always-false — which would mean termination never fires and a commit
 * that cannot build rebuilds for ever. Those rows outlive the writer change, so
 * the read side states git's own abbreviation rule rather than assuming a
 * format.
 */
export function sameCommit(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < MIN_ABBREV) return false;
  return long.startsWith(short);
}
