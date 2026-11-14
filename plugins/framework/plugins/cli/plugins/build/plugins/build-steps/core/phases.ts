/**
 * The points of `./equin build` where contributed steps run, in build order.
 * A closed set: each phase is a place in the build's pipeline, with the
 * context the build has there.
 *
 * - `dependencies`: stage 1 is done — this checkout's `node_modules` and every
 *   registry are current, nothing is deployed yet (the backend this build
 *   restarts will load what a step puts in place).
 * - `deployed`: the checkout's own app is published and its backend restarted;
 *   `namespace` is the namespace it is served at. Skipped by a build that
 *   deploys only other compositions.
 */
export const BUILD_PHASES = ["dependencies", "deployed"] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];
