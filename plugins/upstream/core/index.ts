// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it spawns git through
// `spawn/core`. It lives in `core/` because several runtimes ask the same
// question — the `./equin upstream` / `./equin version` commands and this
// plugin's server and machine halves — and "how far behind upstream's release
// am I" must have one answer, not several that drift. The web-safe half (the
// release tag grammar, the live status value) is `upstream/release`.

export {
  currentRelease,
  fetchUpstreamStatus,
  OWN_RELEASE_NAMESPACE,
  releaseInCommit,
  standingAgainst,
  upstreamReleaseNamespace,
  UPSTREAM_BRANCH,
} from "./internal/status";
export type { ReleaseStanding, UpstreamStatus } from "./internal/status";
