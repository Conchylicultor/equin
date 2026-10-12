/**
 * The CLI bootstrap: everything `bin/index.ts` must be able to run with
 * `node_modules` ABSENT or stale.
 *
 * THIS BARREL'S STATIC CLOSURE MUST REACH NO NPM PACKAGE. `bin/index.ts`
 * imports it before `ensureDeps()` has run, and static imports hoist above every
 * statement in a module — so one npm specifier reachable from here turns a fresh
 * checkout (or any `rm -rf node_modules`) into an unresolved-module crash before
 * the CLI can install its own dependencies. Node builtins, relative repo files
 * and `@plugins/*` aliases only. Enforced by `cli:bootstrap-package-free`, which
 * measures this closure with `Bun.build` so it cannot drift from what loads.
 *
 * That constraint is also WHY these five modules are here rather than in
 * `op-runtime`: they are already in the pre-install closure today
 * (`ensure-deps → checkout-lock → adaptive-timeout`), and `orphan-guard` / `reexec`
 * are reached directly by the bootstrap. Nothing else belongs here — a module
 * that only *some* command needs goes in `op-runtime`, whose closure is free.
 *
 * `checkout-lock` therefore does NOT read `op-runtime`'s build-progress log (or
 * the op log) to see what a lock holder is doing — `acquireCheckoutLock` takes an
 * `observeHolder` hook and the build passes one in. A dynamic import
 * would also have kept this closure clean, but it hid a real cross-plugin edge
 * from the boundary system (R9 `inline-import`); inverting it means the edge
 * does not exist.
 */

export { ensureDeps } from "./ensure-deps";
export type {
  EnsureDepsOptions,
  EnsureDepsResult,
  InstallOutcome,
} from "./ensure-deps";

export { REEXEC_ENV, reexecAfterInstall, takeReexecBudget } from "./reexec";
export type { ReexecBudget, ReexecOptions, ReexecOutcome } from "./reexec";

export {
  LOCKED_BUN_REEXEC_ENV,
  lockedBunVersion,
  reexecUnderLockedBun,
} from "./locked-bun";
export type { LockedBunOptions, LockedBunOutcome } from "./locked-bun";

export {
  ORPHAN_EXIT_CODE,
  disarmOrphanGuard,
  installOrphanGuard,
} from "./orphan-guard";

export { acquireCheckoutLock } from "./checkout-lock";
export type {
  AcquireCheckoutLockOptions,
  HolderObservation,
} from "./checkout-lock";

export { adaptiveTimeoutMs } from "./adaptive-timeout";
