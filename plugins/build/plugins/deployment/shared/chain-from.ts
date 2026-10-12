import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { ChainSchema } from "../core";

/**
 * The answer to "draw me the chain from this commit up to HEAD".
 *
 * A discriminated union rather than a possibly-empty `commits`, because the two
 * arms are genuinely different statements and an empty list would read as the
 * one thing it never means — "this commit IS HEAD".
 */
export const ChainFromSchema = z.discriminatedUnion("kind", [
  /**
   * The walk, newest first, INCLUSIVE of the asked-for commit's own row — the
   * same `Chain` (and the same `chainTo`) the deployment resource carries, so
   * the two are one shape rather than two to reconcile. It carries its own
   * `truncated`, because a walk from a long-open tab is the one most likely to
   * hit the cap.
   */
  z.object({ kind: z.literal("chain"), chain: ChainSchema }),
  /**
   * There is no line to draw from this commit, and the reason IS the answer: the
   * checkout was rebased or force-pushed under the tab, git cannot place the
   * commit at all (a dist built on a branch since pruned), or there is no
   * checkout to place it in.
   */
  z.object({ kind: z.literal("unplaceable"), reason: z.string() }),
]);
export type ChainFrom = z.infer<typeof ChainFromSchema>;

/**
 * The chain the Build button draws runs from the oldest DEPLOYABLE pin up to
 * HEAD, and that range is chosen on the server — which cannot know where a
 * browser tab is. A tab that has not reloaded since the last build sits BELOW
 * the start of that range, so it has no row to stand on.
 *
 * This value is the missing half: given the commit of a carrier the server
 * does not know about, walk the chain from there. The client then renders ONE
 * chain covering every carrier, and "how far behind is this tab" is something
 * you read off the rail instead of a sentence saying the commit is not there.
 *
 * One tuple per CLIENT'S pin — two tabs on one backend ask two different
 * questions. Served external, `notified` by every tracked ref advance
 * (`recomputeOn: [refHeadServed]`): the walk ends at HEAD, so a moved HEAD is
 * the one thing that changes the answer. The commit is a sha and only a sha —
 * it reaches `git` as an argv entry, so its shape is pinned by the typed param
 * (7 is git's shortest unambiguous abbreviation; 40 a full sha).
 */
export const chainFrom = liveValue("build.chain-from", {
  schema: ChainFromSchema,
  params: { commit: z.string().regex(/^[0-9a-f]{7,40}$/) },
});
