// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it reads package.json
// files and bun.lock from disk and spawns git. It lives in `core/` so the
// `deps-npm:*` checks (core-only) and the updater share one reading of the
// workspace. Never import it from `web/`.

export { rangeAt } from "./internal/spec";
export type { Workspace } from "./internal/workspace";
export {
  installedVersions,
  readWorkspace,
  workspaceManifests,
} from "./internal/workspace";
export type { Packument, Plan } from "./internal/plan";
export { planNpm } from "./internal/plan";
export {
  groupProblems,
  policyProblems,
  unrangedSpecs,
} from "./internal/coherence";
