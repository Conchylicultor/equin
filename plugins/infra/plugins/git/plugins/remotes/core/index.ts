// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: everything behind this
// barrel spawns `git`. It lives in `core/` because both runtimes ask the same
// question — the CLI's `push` before it reaches the network, and the server's
// daily upstream check — and the classification must have ONE definition.
// This plugin must NEVER be imported from `web/`.

export type {
  LocalReason,
  PublishTarget,
  UpstreamRemote,
} from "./internal/types";
// Why a remote git command failed, as one table. A failed `fetch` asks the same
// question a failed push probe does, and the ordering of the pattern sets is
// the easy part to get wrong — so it has one spelling, not one per caller.
export { classifyRemoteFailure } from "./internal/classify";
export type { RemoteCapture, RemoteFailure } from "./internal/classify";
export {
  describePublishTarget,
  recordPushRejection,
  remoteUrl,
  resolvePublishTarget,
  PUBLISH_REMOTE,
} from "./internal/publish-target";
export { resolveUpstreamRemote } from "./internal/upstream";
export {
  gitConfigGet,
  gitConfigSet,
  gitConfigUnset,
} from "./internal/git-config";
export { sameRepoUrl } from "./internal/remote-url";
// Who signs the commits push and upstream merge make — decided per publish
// target, at commit time, never at install.
export {
  describeAutoIdentity,
  ensureCommitIdentity,
} from "./internal/commit-identity";
export type { CommitIdentity } from "./internal/commit-identity";
