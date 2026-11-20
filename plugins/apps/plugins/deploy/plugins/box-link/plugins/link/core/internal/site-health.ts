import { z } from "zod";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BoxLinkSchema } from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import { DeployRunSchema } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { RunningCommitSchema } from "@plugins/apps/plugins/deploy/plugins/remote-deploy/core";

/**
 * Whether this instance holds the deployment's link: `linked` with its
 * record, or `main-only` — a real box, linked from main alone (one instance
 * per user holds the real links; a worktree links only demo stand-ins).
 */
export const SiteLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linked"), link: BoxLinkSchema }),
  z.object({ kind: z.literal("main-only") }),
]);
export type SiteLink = z.infer<typeof SiteLinkSchema>;

/** The deployment's most recent run, as the live view holds it (`deploy.runs`). */
export const SiteRunSchema = DeployRunSchema.pick({
  id: true,
  verb: true,
  phase: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  message: true,
});
export type SiteRun = z.infer<typeof SiteRunSchema>;

/**
 * One deployed site's health, folded on the server from three owners:
 * the link (`deploy.box-links`), its newest deploy run (deployments' live
 * view: deploying / failed) and what it runs against main
 * (remote-deploy's running commit: behind by N). `hostname` is the first
 * public hostname, `null` when it has none.
 */
export const SiteHealthSchema = z.object({
  deploymentId: z.string(),
  compositionId: z.string(),
  hostname: z.string().nullable(),
  link: SiteLinkSchema,
  /** `null`: never deployed. */
  run: SiteRunSchema.nullable(),
  release: RunningCommitSchema,
});
export type SiteHealth = z.infer<typeof SiteHealthSchema>;

/**
 * Every deployment's health, keyed by deployment id — ONE value, so the
 * health report's row set reads every site with one `useLive`. Recomputed
 * when a link changes state (never on a beat), a deploy run moves, a
 * deployment changes, or main advances.
 */
export const siteHealth = liveValue("deploy.site-health", {
  schema: wholeRecord(SiteHealthSchema, {
    reason: "one entry per deployment row — a handful",
  }),
  needsMachine: { feature: "A deployed site's live health" },
});

/**
 * Retry now: restart one deployment's link — reopen its tunnel (a refused
 * one included), respawn it without waiting out its backoff, and reconnect
 * the stream. A write: the link's state says how it went.
 */
export const boxLinkRetryEndpoint = defineEndpoint({
  route: "POST /api/box-link/:deploymentId/retry",
  needsMachine: { feature: "Retrying the link to a deployed site" },
});
