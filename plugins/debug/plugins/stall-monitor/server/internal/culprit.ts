import type { StallSection, StallStack } from "@plugins/debug/plugins/trace/plugins/stall/core";

// Derive the report's dedup grain + label from the raw stall evidence.
//
// This is the one place that turns "the stacks that were on the frozen loop" into
// a stable fingerprint and a human-readable label — a presentation concern, so it
// lives here (in the alert plugin) rather than mutating the evidence
// `StallSection`.
//
// Fingerprint = the STACK, not the leaf. A real flaw caught in review: on the
// Jul-7 stall `topLeaves[0]` is `JSON.parse [native]` — a generic native frame
// shared by every JSON caller — so a leaf-based fingerprint misattributes and
// collapses unrelated JSON-heavy freezes into one row. The top STACK
// (`parseTranscript ← readEntries ← …`) names the actual caller path, is already
// line-free (names only, robust to edits), and distinguishes callers that share a
// native leaf. That rationale is unchanged and load-bearing: `culpritStack` is
// `topStacks[0].stack` verbatim, and changing it would fork every existing dedup
// row.
//
// The LABEL is derived from THAT SAME STACK's own frames — never from the
// independent `topLeaves` histogram. Why this is structural, not a tweak: the
// aggregator builds `topLeaves` and `topStacks` as two separately-sorted
// populations, so a label drawn from `topLeaves` can describe a DIFFERENT stall
// than the one `culpritStack` fingerprints. It did: a `spawn`-rooted freeze (7 of
// 15 samples, `spawn ← listPanes ← … ← collectLive`) was titled
// `is @ …/drizzle-orm/entity.js:7` — a 1-of-15 frame with nothing to do with the
// freeze — because the old scan filtered `topLeaves` for ` @ `, skipped the
// unattributed-but-dominant native `spawn`, and landed on an arbitrary cold tie.
// Reading `topStacks[0].frames` makes label/fingerprint coherence hold BY
// CONSTRUCTION: both now describe the same stack, so they cannot drift apart.
//
// Both the label and the fingerprint guard the empty section: `aggregateTraces`
// returns empty arrays when `total === 0`, so we never index `[0]` blindly — the
// `?? …` fallbacks cover it.
//
// A BLOCK with no sample in it is its own finding, not an unknown: the thread
// ran no JS for the whole block (descheduled on an overloaded host, faulting
// its pages back in, or in native work outside the VM), so no stack of this
// process blocked it. It gets its own fingerprint and says so, rather than the
// generic fallback that reads as "the sampler missed it".
export const NO_JS_IN_BLOCK = "no JS ran during the block";

export function deriveCulprit(section: StallSection): {
  culpritStack: string;
  hotFrame: string;
} {
  if (section.scope === "block" && section.nSamples === 0) {
    return {
      culpritStack: NO_JS_IN_BLOCK,
      hotFrame: `${NO_JS_IN_BLOCK} (thread off the CPU or outside JS)`,
    };
  }
  const top = section.topStacks[0];
  return {
    culpritStack: top?.stack ?? "unknown",
    // `hotFrameOf` returns undefined for pre-`frames` traces (the field is
    // optional for back-compat) and for the empty section; the legacy
    // `topLeaves[0]` scan is the fallback for exactly those.
    hotFrame: hotFrameOf(top) ?? section.topLeaves[0]?.key ?? "event-loop stall",
  };
}

// `frameKey` is `name @ path:line` for JS frames and `name [category]` for native
// ones, so ` @ ` is the "this frame is attributable to a source location" test.
function isAttributable(frameKey: string): boolean {
  return frameKey.includes(" @ ");
}

// Strip the ` [category]` suffix off a native frameKey: `spawn [Unknown
// Executable]` → `spawn`. The category is noise once the frame is only the
// *what* half of a `what ← where` label.
function leafName(frameKey: string): string {
  const bracket = frameKey.indexOf(" [");
  return bracket === -1 ? frameKey : frameKey.slice(0, bracket);
}

// Name *what* burned the samples and *where* it was called from, using only this
// stack's own frames (innermost → outermost, per the `frames[i]` ↔
// `stack.split(" ← ")[i]` invariant `aggregateTraces` guarantees).
//
// The leaf is what actually burned samples, so it always leads. But a native leaf
// (`spawn`, `JSON.parse`) is generic — it names a mechanism, not a subsystem — so
// we walk outward for the first frame carrying a source location and append it as
// the *where*. An already-attributable leaf needs no such prefix: it is both.
function hotFrameOf(top: StallStack | undefined): string | undefined {
  const frames = top?.frames;
  if (!frames || frames.length === 0) return undefined;

  const leaf = frames[0]!;
  if (isAttributable(leaf)) return leaf;

  const caller = frames.find(isAttributable);
  // Nothing attributable anywhere (an all-native stack): the bare leaf key —
  // category suffix intact — is the most honest label available.
  return caller ? `${leafName(leaf)} ← ${caller}` : leaf;
}
