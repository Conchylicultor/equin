import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import type {
  BundleResolution,
  Staleness,
} from "@plugins/release/plugins/bundles/core";
import type { ReleaseCandidate } from "../../core/candidate";

/** One `(composition, platform)` pair the candidate is observed for. */
export interface CandidatePair {
  composition: string;
  platform: string;
}

/** What an observation reads — the filesystem and git, injected so it is testable. */
export interface CandidateSources {
  /** `rev-parse HEAD` of the checkout staleness is measured against. */
  headSha(): Promise<string>;
  /** Stat-only fingerprint of every bundle fact `resolve` reads. */
  bundleSignature(pair: CandidatePair): string;
  /** What `ship` would pick — the exact call the CLI makes. */
  resolve(pair: CandidatePair): BundleResolution;
  /** The resolved manifest's provenance against HEAD. */
  compareToHead(
    manifest: Extract<BundleResolution, { ok: true }>["manifest"],
  ): Promise<Staleness>;
}

export interface CandidateObserver {
  /** The ETag: HEAD ‖ bundle signature ‖ this pair's close epoch. */
  signature(pair: CandidatePair): Promise<string>;
  /** The value, read through the memo. */
  get(pair: CandidatePair): Promise<ReleaseCandidate>;
  /** Drop the pair's memo (its last subscriber left). */
  evict(pair: CandidatePair): void;
  /**
   * A candidate release of `pair` closed: every later `get` returns an
   * observation stamped after this instant — never a cache hit, never a
   * compute that was already running.
   */
  noteClosed(pair: CandidatePair): void;
}

/**
 * The memoized observation behind `release.candidate`.
 *
 * **The memo.** Signature = `rev-parse HEAD` ‖ `bundleSignature` (stat-only:
 * the pointer's target, the manifest's mtime and size, the packed binary's
 * existence) ‖ this pair's close epoch. The resource's `revalidate` is that same
 * signature, so the ETag and the value cannot disagree. A recompute whose
 * signature did not move is a cache hit returning the SAME value, which the
 * runtime's no-op suppression then drops. A failed compute is not cached (a
 * corrupt `RELEASE.json` throws out of `resolve`), so it is the value's error
 * arm and the next read retries.
 *
 * **The close is what keeps `observedAt` honest.** The client holds its release
 * info `loading` while the candidate provably predates the newest run
 * (`observedAt < latest.finishedAt` for a refusal); after a close, an
 * observation that predates it would hold that gate forever, because nothing
 * notifies the pair again until HEAD moves. Two ways one could leak through,
 * and one guard each:
 *
 * - a **cache hit** — a close whose bundle signature happened not to move (a
 *   run that succeeded yet claimed no pointer) keeps the old `observedAt`. The
 *   close **epoch** in the signature makes it a miss.
 * - a **joined flight** — a compute started before the close (a HEAD-advance
 *   recompute, a row mounting) and still in its `compareToHead` spawn would be
 *   joined by the post-close miss and hand back its pre-close value. The close
 *   **instant** is passed as the memo's `notBefore`, so such a flight is
 *   superseded, not joined.
 *
 * The epoch carries the process's boot instant, so an ETag minted by a previous
 * process never matches one minted by this one.
 */
export function createCandidateObserver(
  sources: CandidateSources,
): CandidateObserver {
  const boot = `${process.pid}.${Date.now()}`;
  /**
   * Per pair: how many candidate closes this process saw, and when the last one
   * was noted (`performance.now()`, the inflight floor's clock). Kept across
   * evictions — one entry per pair ever closed, bounded by compositions ×
   * platforms.
   */
  const closes = new Map<string, { epoch: number; at: number }>();

  const keyOf = (pair: CandidatePair) =>
    `${pair.composition}\0${pair.platform}`;
  const pairOf = (key: string): CandidatePair => {
    const at = key.indexOf("\0");
    return { composition: key.slice(0, at), platform: key.slice(at + 1) };
  };

  const memo = createSignedMemo<ReleaseCandidate>({
    name: "release:candidate",
    signature: async (key) => {
      const head = await sources.headSha();
      return [
        head,
        sources.bundleSignature(pairOf(key)),
        `${boot}.${closes.get(key)?.epoch ?? 0}`,
      ].join("\u0001");
    },
    compute: async (key) => {
      // Stamped BEFORE the filesystem is read: whatever the read sees is at
      // least as new as this instant, which is the direction the client's gate
      // needs (a run that finished before `observedAt` is in `resolution`).
      const observedAt = new Date();
      const resolution = sources.resolve(pairOf(key));
      if (!resolution.ok) {
        // No bundle ⇒ nothing whose source state could be compared. Reported as
        // `unknown` with the true reason rather than as a null field: the
        // refusal beside it says which of the nine ways it is.
        return {
          resolution,
          staleness: {
            kind: "unknown",
            reason: "there is no shippable bundle to compare — see the refusal",
          },
          observedAt,
        };
      }
      // The MANIFEST's provenance: it is the one that always exists — a
      // hand-run `./equin release` writes a manifest and no row at all.
      const staleness = await sources.compareToHead(resolution.manifest);
      return { resolution, staleness, observedAt };
    },
  });

  return {
    signature: (pair) => memo.signature(keyOf(pair)),
    get: (pair) => {
      const key = keyOf(pair);
      return memo.get(key, { notBefore: closes.get(key)?.at });
    },
    evict: (pair) => memo.evict(keyOf(pair)),
    noteClosed: (pair) => {
      const key = keyOf(pair);
      closes.set(key, {
        epoch: (closes.get(key)?.epoch ?? 0) + 1,
        at: performance.now(),
      });
    },
  };
}
