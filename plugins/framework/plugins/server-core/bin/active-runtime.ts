// The desktop's native probes (memory, snapshot hash), installed into `core`
// before either boot mode loads the graph — see `./host-probes`.
import "./host-probes";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
// The registry import goes through the `@composition-server-registry` alias
// (declared in tsconfig.base.json → `bin/plugins-active`). In dev this resolves
// to `plugins-active.ts`, whose existsSync selector picks full vs. filtered at
// runtime — identical behavior to a direct relative import. At release-compile
// time, `release.ts` overrides this alias to resolve STATICALLY to that
// release's filtered `core/server.composition.<name>.generated.ts`, so the
// bundler's closure IS the composition closure (no runtime dynamic specifier to
// defeat `bun --compile`).
import { serverEntries } from "@composition-server-registry";
// The machine half, the same way: `@composition-machine-registry` resolves to
// `plugins-active.ts` in dev and to the release's filtered
// `core/machine.composition.<name>.generated.ts` at compile time.
import { machineEntries } from "@composition-machine-registry";

// ── What this process is booting, and where its plugins live on disk ─────────
//
// Both boot modes need exactly these two answers, so they are stated once here
// rather than in each composition root:
//
// - `serve` (`./index.ts`) imports this statically.
// - `exec` (`../cli/run-exec.ts`) imports it DYNAMICALLY, so that a command
//   declaration reaching the exec barrel keeps a trivial static closure (the
//   `cli:command-declarations-light` check stops at dynamic-import edges).
//
// It lives under `bin/` — beside the three files that already answer "which app
// is this backend" (`plugins-active`, `select-registry`, `spec-composition`) —
// and NOT under `shared/`, because `PLUGINS_DIR` comes from `paths/core` while
// `paths/server` imports this plugin's `core`: a `shared/`-tagged edge to
// `paths` would close a cycle in the server import graph. `bin/` and `cli/`
// edges sit outside that graph, so both consumers can reach it from here.

export { serverEntries, machineEntries };

/**
 * Whether `plugins/<pluginPath>/core/index.ts` exists — the predicate the load
 * waves use to decide which core barrels to warm. `PLUGINS_DIR` is derived from
 * the paths plugin's own location, not from cwd; in a `bun --compile` release it
 * may not exist on disk at all, and returning false there is correct (the whole
 * graph is one bundle, so there is no cold-barrel race to warm away).
 */
export function hasCoreBarrel(pluginPath: string): boolean {
  return existsSync(join(PLUGINS_DIR, pluginPath, "core", "index.ts"));
}
