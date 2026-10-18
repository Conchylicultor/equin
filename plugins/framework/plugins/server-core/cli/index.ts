// The `exec` boot mode: boot this process, run one registered piece of work,
// exit. `serve` — the long-lived gateway-spawned backend — is `bin/index.ts`;
// both run the one sequence in `core/boot-stages.ts`. See `./run-exec.ts` for
// what `exec` skips and why each skipped phase would be wrong in a short-lived
// process.
//
// A `cli/` barrel that declares no command, like the shared-machinery barrels
// under `framework/cli/plugins`: it is the legal cross-plugin entry point for a
// `./singularity` verb that needs a booted runtime.
export { runExec } from "./run-exec";
