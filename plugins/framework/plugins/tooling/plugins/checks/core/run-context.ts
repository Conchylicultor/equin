// Build-process marker for dist-comparing checks.
//
// `./equin build` runs the check fleet IN PARALLEL with the frontend
// build and publishes the fresh dist only afterwards — so a check that compares
// the currently-DEPLOYED dist against the current tree (e.g.
// `web-artifacts:map-in-sync`) would fail exactly when the build is about to
// reconcile them: the dist it inspects is the one this very build replaces.
// Such checks skip (and must return `null` from `cacheSignature()`, so the skip
// is never recorded as a cached pass) when the marker is set.
//
// Env-based on purpose, and MORE so now than when this was written: `build` no
// longer runs checks in-process — it spawns the `check` command through
// `cli/plugins/op-runtime/cli/check-subprocess.ts`. The env is therefore the PROPAGATION
// mechanism, not an in-process convenience: the child inherits the marker and
// skips the same checks its parent would have, which is exactly what has to
// keep happening. A standalone check and a push-spawned one inherit no build's
// environment, so both verify the deployed dist for real.

const BUILD_IN_PROGRESS_ENV = "SINGULARITY_BUILD_IN_PROGRESS";

/**
 * Called once at the start of the `build` command's action.
 *
 * Stamps the PID, not a bare `"1"`, so the value distinguishes the build
 * process itself from the check pass it spawns — the child inherits the string
 * but not the pid that wrote it. "Does a build own this process tree?" and "is
 * this THE build process?" are then two questions answered from one variable,
 * rather than one question that cannot express the other.
 */
export function markBuildInProgress(): void {
  process.env[BUILD_IN_PROGRESS_ENV] = String(process.pid);
}

/**
 * True inside a build process AND inside the check pass it spawns (checks
 * racing the publish). A non-empty test, deliberately: the spawned child
 * inherits the marker carrying the PARENT's pid, and it must — it is the
 * process actually running the dist-comparing checks, so it is the one that has
 * to skip them.
 */
export function isBuildInProgress(): boolean {
  return (process.env[BUILD_IN_PROGRESS_ENV] ?? "") !== "";
}

/** True only in the build process ITSELF — never in the check pass it spawns. */
export function isBuildProcess(): boolean {
  return process.env[BUILD_IN_PROGRESS_ENV] === String(process.pid);
}
