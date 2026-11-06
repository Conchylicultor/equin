import { z } from "zod";

// Tunable constants for the client-side render-loop detector. Single source of
// truth (imported by the detector via the core barrel) so the heuristic's
// thresholds live next to the schema/fingerprint that consume their output.
export const RENDER_LOOP = {
  // Sliding-window length for the per-signature rate counters.
  WINDOW_MS: 1000,
  // A signature must stay above its class threshold continuously this long
  // before it fires — excludes one-off bursts (live-state, layout settle).
  SUSTAINED_MS: 3000,
  // childList identical-rebuild threshold (rebuilds/sec).
  REBUILD_PER_SEC: 3,
  // no-op / oscillating attribute-write threshold (writes/sec).
  NOOP_ATTR_PER_SEC: 30,
  // No qualifying user interaction within this window → "idle".
  IDLE_MS: 2000,
  // Per-(signature, attr) ring of recent attribute values used to detect
  // oscillation (a small set of values cycled, vs monotonic progress).
  VALUE_RING: 8,
  // Oscillation: at most this many distinct values in the ring …
  MAX_DISTINCT_VALUES: 4,
  // … with at least one value revisited this many times.
  MIN_VALUE_REPEAT: 3,
  // bounded `nth-of-type` path depth from the node up to the marker anchor.
  PATH_MAX_DEPTH: 4,
  // Hard cap on the serialized signature string length. An over-long signature
  // keeps whole head/tail segments and folds the elided middle into a hash of
  // the whole (web/internal/cap-signature.ts), so the cap never merges two nodes.
  SIGNATURE_CAP: 256,
  // Drop a per-signature counter once it's been idle longer than this (GC).
  GC_IDLE_MS: 5000,
  // Throttle near-miss log lines to at most one per signature per this window,
  // so a sustained idle non-wasted update can't flood the clientLog buffer.
  NEAR_MISS_LOG_MS: 10000,
  // --- Aggregate (subtree-cascade) tier ---
  // The summed-rate thresholds are SPLIT by mutation class, mirroring the leaf
  // tier's split — because a childList rebuild (a torn-down + rebuilt subtree) is
  // only ~2 MutationRecords yet far costlier than an attribute write, so the two
  // classes can't share one count-based floor. A diffuse rebuild cascade (e.g.
  // every code block remounted on each transcript re-render) is only ~8 records/s
  // total but a real loop; raw-count attribute churn is ~300/s.
  // Summed childList records/sec across the subtree (≈2× the 3/s leaf rebuild
  // floor — a genuine multi-subtree rebuild cascade, not one occasional list edit).
  AGG_REBUILD_PER_SEC: 6,
  // Summed attribute records/sec across the subtree (2× the 30/s leaf attr floor,
  // so a single hot leaf can never satisfy it alone — forces genuine breadth).
  AGG_ATTR_PER_SEC: 60,
  // Distinct recurring leaf signatures the cascade must touch (separates a
  // diffuse whole-subtree cascade from a single concentrated leaf loop).
  AGG_MIN_LEAVES: 5,
  // A leaf must recur ≥ this many times within the window to count toward breadth
  // (drops one-shot initial-render bursts; a re-render re-touches the same node).
  AGG_MIN_LEAF_REPEAT: 2,
  // Memory cap on distinct tracked leaves per aggregate root (new leaf keys are
  // skipped once full; existing keys keep updating).
  AGG_MAX_TRACKED_LEAVES: 256,
  // Number of sample leaf signatures (hottest first) attached to a cascade report.
  AGG_SAMPLE_LEAVES: 6,
  // --- Attribution ---
  // Before a loop is filed, the React commit profiler (debug/render-profiler)
  // watches this long, so the report names the component and hook that start
  // each re-render — or says that no React commit drives the writes at all.
  ATTRIBUTE_MS: 1500,
  // Initiating components attached to a report (most commits first).
  ATTRIBUTE_TOP: 3,
  // A component counts as driving the loop only at this many commits/sec or
  // more (the rebuild floor): the app's background commits (a status probe,
  // a toast) are far below it and must not be named as a loop's cause.
  ATTRIBUTE_MIN_COMMITS_PER_SEC: 3,
} as const;

/**
 * Declares an element whose subtree an imperative animation draws (a rAF loop
 * writing an SVG scene, a canvas overlay's DOM): its descendants' writes are
 * the animation's frames, not a render loop, so the detector does not count
 * them. React-rendered descendants are still watched — only nodes React does
 * not own are skipped — so a real re-render loop inside the host still fires.
 * Spread on the host element: `<div {...ANIMATION_HOST} />`.
 */
export const ANIMATION_HOST_ATTR = "data-animation-host";
export const ANIMATION_HOST = { [ANIMATION_HOST_ATTR]: "" } as const;

/** One React component found starting the re-renders behind a loop. */
export const RenderLoopInitiatorSchema = z.object({
  /** The component whose own state/store/context changed. */
  component: z.string(),
  /** Its nearest named ancestors, outermost first. */
  ancestors: z.array(z.string()),
  /** The hooks that changed, as `<kind>#<index>` (e.g. `external-store#7`). */
  hooks: z.array(z.string()),
  commitsPerSec: z.number(),
});
export type RenderLoopInitiator = z.infer<typeof RenderLoopInitiatorSchema>;

// The render-loop report payload, stored in the generic `data` jsonb column and
// validated on ingest by the render-loop ReportKind. Captures the stable culprit
// signature, its composition markers, the detected mutation class, and the rate
// / timing context (the latter excluded from the fingerprint so repeats dedup).
export const RenderLoopPayloadSchema = z.object({
  signature: z.string(),
  pluginId: z.string().nullable().optional(),
  slotId: z.string().nullable().optional(),
  contributionId: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  paneId: z.string().nullable().optional(),
  selector: z.string().nullable().optional(),
  mutationClass: z.enum([
    "noop-attr",
    "oscillating-attr",
    "childlist-rebuild",
    "subtree-cascade",
  ]),
  attrName: z.string().nullable().optional(),
  ratePerSec: z.number(),
  sustainedMs: z.number(),
  sampleValues: z.array(z.string()).nullable().optional(),
  tagMultiset: z.array(z.string()).nullable().optional(),
  // Aggregate (subtree-cascade) tier only — back-compat: leaf reports leave these
  // null. distinctLeaves = recurring breadth at fire; sampleLeaves = the hottest
  // per-node leaf signatures for attribution.
  distinctLeaves: z.number().nullable().optional(),
  sampleLeaves: z.array(z.string()).nullable().optional(),
  visibilityState: z.string(),
  msSinceInteraction: z.number(),
  // Attribution (RENDER_LOOP.ATTRIBUTE_MS of React commit profiling before the
  // report is filed) — absent on older rows and when no profiler is installed.
  // An empty `initiators` means no component re-rendered at a loop's rate:
  // the writes are not React's — an imperative loop.
  reactCommitsPerSec: z.number().nullable().optional(),
  initiators: z.array(RenderLoopInitiatorSchema).nullable().optional(),
});
export type RenderLoopPayload = z.infer<typeof RenderLoopPayloadSchema>;

// Render-loop fingerprint = sha256(signature + mutationClass + attrName), first
// 16 hex chars. Rate/timing are EXCLUDED so every repeat of the same pathological
// loop dedups onto one row/task (same pattern as crashFingerprint).
export async function renderLoopFingerprint(
  data: RenderLoopPayload,
): Promise<string> {
  const input = `${data.signature}|${data.mutationClass}|${data.attrName ?? ""}`;
  return sha256Hex(input).then((h) => h.slice(0, 16));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
