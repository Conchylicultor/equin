import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { ReleaseManifestSchema } from "@plugins/release/plugins/bundles/core";
import type {
  BundleRefusal,
  BundleResolution,
  Staleness,
} from "@plugins/release/plugins/bundles/core";
import { PlatformTagSchema } from "./platforms";

/**
 * The wire schemas for the two verdicts the `release.candidate` value carries
 * across the network: bundle discovery's `BundleResolution` and provenance's
 * `Staleness`.
 *
 * Both TYPES are owned by `@plugins/release/plugins/bundles/core` — that plugin
 * is the single authority on what a bundle is and why it isn't shippable, and it
 * stays free of any transport concern (a CLI process asks it the same question
 * with no HTTP anywhere in sight). What lives here is only their *serialization*,
 * which is this plugin's value's business.
 *
 * The `satisfies ZodParser<…>` on each schema is what keeps the two from
 * drifting: adding a refusal case, or a field to one, makes THIS file a tsc
 * error rather than a runtime `.parse()` failure in the browser. Never relax it
 * to a cast.
 */
const BundleRefusalSchema = z.union([
  z.object({
    kind: z.literal("no-releases"),
    composition: z.string(),
    platform: z.string(),
    compDir: z.string(),
    namespace: z.string(),
  }),
  z.object({
    kind: z.literal("no-such-run"),
    release: z.string(),
    runDir: z.string(),
    compDir: z.string(),
    available: wholeList(z.string(), {
      reason:
        "one composition's release run dirs on disk — the few the artifact prune keeps",
    }),
    namespace: z.string(),
  }),
  z.object({
    kind: z.literal("no-pointer"),
    pointer: z.string(),
    pointerPath: z.string(),
    namespace: z.string(),
  }),
  z.object({ kind: z.literal("no-manifest"), runDir: z.string() }),
  z.object({
    kind: z.literal("wrong-composition"),
    manifestPath: z.string(),
    found: z.string(),
    expected: z.string(),
  }),
  z.object({
    kind: z.literal("wrong-target"),
    manifestPath: z.string(),
    found: z.string(),
  }),
  z.object({
    kind: z.literal("platform-mismatch"),
    manifestPath: z.string(),
    found: z.string(),
    expected: z.string(),
  }),
  z.object({
    kind: z.literal("inconsistent-run-id"),
    manifestPath: z.string(),
    declared: z.string(),
    runId: z.string(),
  }),
  z.object({ kind: z.literal("not-packed"), localPath: z.string() }),
]) satisfies ZodParser<BundleRefusal>;

export const BundleResolutionSchema = z.union([
  z.object({
    ok: z.literal(true),
    runId: z.string(),
    localPath: z.string(),
    binaryName: z.string(),
    manifest: ReleaseManifestSchema,
  }),
  z.object({ ok: z.literal(false), refusal: BundleRefusalSchema }),
]) satisfies ZodParser<BundleResolution>;

export const StalenessSchema = z.union([
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("behind"), commits: z.number().int() }),
  z.object({ kind: z.literal("diverged"), sha: z.string() }),
  z.object({ kind: z.literal("unknown"), reason: z.string() }),
]) satisfies ZodParser<Staleness>;

/**
 * What `ship` would pick for one `(composition, platform)`, as the
 * `release.candidate` live value carries it.
 *
 * **The filesystem says whether a shippable bundle exists and matches** — that
 * is `resolution`, the EXACT value `ship` itself acts on, so a UI renders
 * `bundleRefusalMessage(resolution.refusal)` verbatim and never re-derives
 * shippability. `staleness` is how its recorded provenance relates to HEAD.
 *
 * There is no `run`: a value read off the filesystem and git cannot also carry
 * a `release_runs` row (a DB read inside an external value is invisible to the
 * change feed). The newest run is its own read — the routed `release.history`
 * window, limit 1 — and a consumer orders the two by `observedAt`.
 *
 * `observedAt` is when the server last looked: the start of the newest
 * observation this value describes (a fresh one is taken whenever a release
 * closes, HEAD moves, or the bundle on disk changed). A run that FINISHED
 * before `observedAt` is reflected in `resolution`; one that finished after it
 * may not be yet.
 */
export const ReleaseCandidateSchema = z.object({
  resolution: BundleResolutionSchema,
  staleness: StalenessSchema,
  observedAt: z.coerce.date(),
});
export type ReleaseCandidate = z.infer<typeof ReleaseCandidateSchema>;

/**
 * The release candidate for one `(composition, platform)` — what `ship` would
 * pick, live. External on the server (its truth is the bundle directory and
 * git, not Postgres): it recomputes when HEAD moves and when a candidate
 * release of that pair closes, and a signed memo over HEAD plus the bundle's
 * filesystem fingerprint makes every other recompute a cache hit.
 *
 * Not preloaded: its readers are the Deploy app's release column and pane,
 * one subscription per deployment row, released when the row unmounts.
 */
export const releaseCandidate = liveValue("release.candidate", {
  schema: ReleaseCandidateSchema,
  params: { composition: z.string().min(1), platform: PlatformTagSchema },
});
