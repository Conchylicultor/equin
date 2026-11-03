// The hourly prune job's statement, run on demand: a suite that booted a host
// with L2 (the demo's browser host) proves its changelog is bounded by the same
// policy as the desktop's without waiting for the job's schedule.
export { pruneChangelog } from "../internal/changelog-horizon";
