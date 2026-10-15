import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  triggerReleaseEndpoint,
  previewEndpoint,
  stopPreviewEndpoint,
} from "../core/endpoints";
import { handleRelease } from "./internal/handle-release";
import { handlePreview, handleStopPreview } from "./internal/handle-preview";
import { releaseRunLogsServed } from "./internal/run-logs-resource";
import {
  reconcileOrphanPreviews,
  releasePreviewDaemon,
} from "./internal/preview-manager";
import { releaseJob } from "./internal/release-job";
import {
  releaseHistoryServed,
  releaseRunsServed,
} from "./internal/release-runs-resource";
import { releaseCandidateServed } from "./internal/candidate-resource";
import { releasePreviewsServed } from "./internal/preview-state-resource";
import { IdKinds } from "@plugins/ids/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { RELEASE_CATEGORY_ID } from "../core/task-category";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";
export { _releaseRuns } from "./internal/tables";
export { enqueueRelease } from "./internal/enqueue-release";
export type { TriggerReleaseOptions } from "./internal/enqueue-release";
export { awaitRelease } from "./internal/await-release";
export type { ReleaseEnded } from "./internal/await-release";
// `releaseOutDir` / `newReleaseRunId` are NOT re-exported here: they now live in
// `@plugins/release/plugins/bundles/server`, which is DB-free and therefore
// importable by a CLI process — import them from there.
export { Release, collectReleaseEnv } from "./internal/env-provider";

export default {
  description:
    "Local composition release lifecycle engine: run, observe, preview F4 artifacts.",
  // ONE token mounts both halves of the release job — the queue job and its
  // supervised-run kind. The kind must be REGISTERED, not merely defined: the
  // primitive's own `onReady` reconciler loops the registered set, so a kind
  // that never lands here would start runs nothing ever closes.
  register: [releaseJob, releasePreviewDaemon],
  contributions: [
    IdKinds.Kind({ kind: releaseRunIdKind }),
    TaskCategory({ id: RELEASE_CATEGORY_ID, label: "Release", order: 15 }),
    ...releaseRunsServed.declare,
    ...releaseHistoryServed.declare,
    ...releaseCandidateServed.declare,
    ...releasePreviewsServed.declare,
    ...releaseRunLogsServed.declare,
  ],
  httpRoutes: {
    [triggerReleaseEndpoint.route]: handleRelease,
    [previewEndpoint.route]: handlePreview,
    [stopPreviewEndpoint.route]: handleStopPreview,
  },
  onReady: async () => {
    // Unfinished release_runs rows are no longer reconciled here: that is the
    // supervised-run primitive's ONE reconciler, which adopts a release whose
    // CLI is still running and closes one whose is not — including clearing the
    // release_runs_inflight_uniq lock for the next release.
    //
    // Drop any preview whose gateway died across the restart, and reap orphan
    // /tmp/sgp-* stacks left running by a prior backend lifetime.
    await reconcileOrphanPreviews();
  },
} satisfies ServerPluginDefinition;
