// The dependency engine, host-only (it reads `paths/core` and the deps data
// dirs), so every host process — a backend, a CLI op, a check, an e2e script —
// reaches it without booting a backend, and `web`/`core` cannot.
//
// What a feature uses: declare (`defineDep`, exported from the feature's own
// `deps/index.ts` and listed in its `default` array), install off the event
// loop (`ensureDep`, needing an ExecContext), take an installed one from a
// request path (`readyNow`, paired with the server barrel's `requestDep`), and
// read the state (`depState`). A host process with no ExecContext of its own
// (a check, an e2e script) installs through a `./equin deps install`
// child (`ensureDepViaCli`). Installer kinds implement `DepSource`; runners
// take a `Ready`. A release seals its `bundle` dependencies for its platform
// (`sealDep`, writing `deps.sealed.json`), and every read above resolves them
// from that manifest when the root is such a bundle. `holdDep` keeps an install
// that something outside any checkout points at (a launchd job) from the sweep
// (`sweepUnusedDeps`, run daily by the `sweep` sub-plugin).
export { defineDep, hostTarget } from "./internal/dep";
export type {
  BundleSpec,
  DefineDepSpec,
  Dep,
  DepSource,
  DepTarget,
  InstallContext,
  Ready,
  TargetedSource,
} from "./internal/dep";
export { depState, ensureDep, readyNow, removeDep } from "./internal/ensure";
export type { EnsureOptions, ReadyNow, RemoveOutcome } from "./internal/ensure";
export { ensureDepViaCli } from "./internal/via-cli";
export { sealDep } from "./internal/seal";
export type { SealOutcome } from "./internal/seal";
export { SEALED_MANIFEST } from "./internal/sealed";
export { holdDep } from "./internal/hold";
export { sweepUnusedDeps } from "./internal/sweep";
export type { SweepReport } from "./internal/sweep";
export {
  declaredDep,
  declaredDeps,
  UnknownDepError,
} from "./internal/registry";
