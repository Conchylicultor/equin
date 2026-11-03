// One worker thread of the pooled artifact builder (`cli/`'s
// `createPooledArtifactBuilder`): answers each `ArtifactBuildRequest` by
// building that artifact into the store, exactly as the in-process builder
// does — same `buildArtifact`, its own Babel contributions loaded on the first
// request.

import { serveThreadPool } from "@plugins/packages/plugins/thread-pool/cli";
import {
  createArtifactBuildHandler,
  type ArtifactBuildRequest,
  type ArtifactMeta,
} from "../core";

serveThreadPool<ArtifactBuildRequest, ArtifactMeta>(
  createArtifactBuildHandler(),
);
