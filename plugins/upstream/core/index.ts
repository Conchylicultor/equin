// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it spawns git through
// `spawn/core`. It lives in `core/` because two runtimes ask the same question
// — the `./equin upstream` command and this plugin's daily server job —
// and "how far behind upstream am I" must have one answer, not two that drift.

export {
  fetchUpstreamStatus,
  UPSTREAM_BRANCH,
  UPSTREAM_SUBJECT_LIMIT,
} from "./internal/status";
export type { UpstreamCommit, UpstreamStatus } from "./internal/status";
