import { runtimePath } from "@plugins/infra/plugins/launcher/core";
import { toolchainPin } from "@plugins/infra/plugins/paths/core";

// ── Pin this backend's toolchain before anything can spawn ───────────────────
//
// Imported right after `./declare-namespace`, ahead of every plugin: a mise tool
// this process (or anything it spawns) runs resolves THIS checkout's locked
// release whatever cwd it runs in, instead of an unlocked system copy or
// `mise ERROR No version is set for shim`. See `toolchainPin` (paths/core).
//
// Here and not in the shared boot sequence: `exec` processes are spawned by a
// backend and inherit this from its environment, and `bin/` is the composition
// root that may reach `paths` without closing a plugin cycle.
//
// PATH too: the gateway hands this backend a shims-first PATH (`runtimePath`),
// but the mise shim that launched it prepended the RESOLVED
// `…/mise/installs/<tool>/<version>/bin` dirs again. Left in place, everything
// this backend spawns runs the toolchain of its boot — including the build that
// is meant to restart it after a `mise.lock` bump, which `bun-runtime` then
// refuses, so the restart never comes (main, 2026-10-12: bun 1.4.2 → 1.4.3).
Object.assign(process.env, toolchainPin(), {
  PATH: runtimePath(process.env),
});
