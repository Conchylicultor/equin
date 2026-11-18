import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Whether the commit main serves can be released now — the same questions
 * `./equin version cut` asks, answered from main's backend (its served dist and
 * its own `build_runs`), so the button is disabled for the reason the cut
 * would give. One stricter: while main builds, nothing is offered (the commit
 * it serves is about to be replaced).
 *
 * - `ready`       — main serves `commit`, its build passed, no release holds it.
 * - `building`    — a main build is in flight (of `commit`, when it recorded one).
 * - `failed`      — main's newest finished build of the served `commit`
 *                   failed; `runId` opens it.
 * - `no-build`    — main has no finished build of the served `commit` on record.
 * - `not-served`  — main serves no known commit (no dist, or one without its
 *                   `.build-commit`).
 * - `released`    — the served `commit` is already in a release (`tag`):
 *                   main has moved on since, and has not served the newer
 *                   commits yet.
 *
 * Commits are full shas; the page shortens them.
 */
export const ReleasabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), commit: z.string() }),
  z.object({ kind: z.literal("building"), commit: z.string().nullable() }),
  z.object({
    kind: z.literal("failed"),
    commit: z.string(),
    runId: z.string(),
  }),
  z.object({ kind: z.literal("no-build"), commit: z.string() }),
  z.object({ kind: z.literal("not-served") }),
  z.object({
    kind: z.literal("released"),
    commit: z.string(),
    tag: z.string(),
  }),
]);
export type Releasability = z.infer<typeof ReleasabilitySchema>;

/**
 * The releases of the checkout that publishes them (no upstream — the author's
 * main), as its health row reads them.
 *
 * - `not-publisher` — this backend is not main's, or main's checkout cannot
 *   publish (a clone; no writable remote). It cuts no releases: the row is
 *   absent.
 * - `publisher`     — `latest`, the newest release on local `main` (`null`:
 *   none cut yet) and when it was cut (ISO); `unreleased`, the commits on
 *   `main` since it; `releasable`, whether the commit main serves can be cut.
 */
export const PublisherStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-publisher") }),
  z.object({
    kind: z.literal("publisher"),
    latest: z.object({ tag: z.string(), taggedAt: z.string() }).nullable(),
    unreleased: z.number().int().nonnegative(),
    releasable: ReleasabilitySchema,
  }),
]);
export type PublisherStatus = z.infer<typeof PublisherStatusSchema>;

/**
 * The live publisher status. One small value, pushed; recomputed when `main`
 * moves, when a build starts or ends, when the backend serves a new build,
 * and after a cut through {@link cutReleaseEndpoint}.
 */
export const upstreamPublisherStatus = liveValue("upstream.publisher-status", {
  schema: PublisherStatusSchema,
  needsMachine: { feature: "Releases" },
});

/**
 * The exit code `./equin version cut` refuses with — and ONLY a refusal: the
 * cut looked and found a reason not to release (its reason on stderr). Not 1,
 * which every CLI failure exits with (an uncaught throw, a failed install):
 * sharing it made a crashed cut read as a refusal — a toast, no report — so a
 * broken button could never be investigated (2026-11-18).
 */
export const CUT_REFUSED_EXIT_CODE = 3;

/**
 * Cut a release: run `./equin version cut` in main's checkout — the CLI
 * itself, so the button and the terminal share one implementation and every
 * refusal. `released` carries what the cut said it did; `refused`, the cut's
 * own refusal, word for word.
 */
export const cutReleaseEndpoint = defineEndpoint({
  route: "POST /api/upstream/release",
  response: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("released"), detail: z.string() }),
    z.object({ kind: z.literal("refused"), detail: z.string() }),
  ]),
  needsMachine: { feature: "Releases" },
});
