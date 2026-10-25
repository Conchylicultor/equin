import type { PublishTarget } from "./types";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/**
 * The two `.git/config` keys the probe's answer is recorded under.
 *
 * `.git/config` and not a `config_v2` value on purpose: this is a CACHE OF A
 * MEASUREMENT, not a setting. A user-editable "may I publish" field would be a
 * claim the remote can contradict — and does, every time it refuses a push.
 */
export const CACHE_REMOTE_KEY = `${LEGACY_IDS.gitConfigSection}.publish.remote`;
export const CACHE_URL_KEY = `${LEGACY_IDS.gitConfigSection}.publish.url`;

/**
 * What `CACHE_REMOTE_KEY` holds when the remote answered that we may
 * NOT write to it. A sentinel rather than an absent key, because absent means
 * "never probed" and this means "probed, and the answer was no".
 */
export const NO_PUBLISH = "none";

/** The recorded pair, straight off `.git/config`. */
export interface CachedProbe {
  remote: string | null;
  url: string | null;
}

/**
 * Is the recorded answer still about the remote we are looking at?
 *
 * `stale` is not a failure — it is the instruction to probe, which is the only
 * thing that can produce an answer.
 */
export type CacheDecision =
  { kind: "hit"; target: PublishTarget } | { kind: "stale" };

/**
 * The cache's whole rule, as a pure function of what was recorded and what the
 * remote looks like right now.
 *
 * The URL comparison is EXACT text, not the normalised repo identity used
 * against `CANONICAL_REPO_URL`. A user who re-points origin from https to ssh
 * has changed how they authenticate to it, which is precisely the input to the
 * answer we cached — so the cheap thing to do is re-probe, and treating the two
 * spellings as one would skip that.
 */
export function cacheDecision(
  cached: CachedProbe,
  remote: string,
  url: string,
): CacheDecision {
  if (!cached.remote || !cached.url) return { kind: "stale" };
  if (cached.url !== url) return { kind: "stale" };
  if (cached.remote === NO_PUBLISH) {
    return {
      kind: "hit",
      target: {
        kind: "local",
        reason: {
          kind: "read-only",
          remote,
          url,
          detail: "recorded by an earlier write probe",
        },
      },
    };
  }
  // A recorded remote NAME that is not the one we are asking about answers a
  // different question than the one being asked, so it is not a hit.
  if (cached.remote !== remote) return { kind: "stale" };
  return { kind: "hit", target: { kind: "publish", remote, url } };
}
