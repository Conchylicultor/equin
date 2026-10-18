import { join } from "path";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { worktreesDir } from "@plugins/infra/plugins/paths/core";
import { selectRegistry } from "./select-registry";
import { readSpecComposition } from "./spec-composition";

// The boot-time application of the two pure, tested steps beside this file:
// `./spec-composition` answers WHICH APP this backend is, and `./select-registry`
// turns that into a registry path.
//
// Which COMPOSITION comes off `~/.singularity/worktrees/<namespace>/spec.json` —
// the same file the gateway read to spawn this process — rather than from a
// value the gateway would have to pass. `./singularity build` rebuilds this
// backend but not the Go gateway, so a running gateway is routinely older than
// the tree it serves; a value that had to survive that hop could silently go
// missing, and a missing composition means booting the full app under a
// composition's own namespace and database. Reading the file leaves nothing to
// drop, and no way for the gateway's view and the backend's to disagree.
//
// The NAMESPACE is the other half, and it cannot be read off disk — it is which
// spec dir to look in. It comes from `runtime-identity`, declared by
// `./declare-namespace` from the `--namespace` argv the gateway spawned this
// process with.
//
// `worktreesDir` is free here — `bin/index.ts` already imports this same barrel,
// so nothing is added to the boot import closure.
//
// All composition registries are gitignored, so the specifier is held in a
// variable (never a string literal pointing at a maybe-absent file) — tsc must
// not try to resolve the gitignored modules. Bun runs this unbundled, so the
// guarded dynamic import loads only the branch taken.
//
// Both halves of the backend — every plugin's `server/` and every plugin's
// `machine/` — come from the same composition, so they always describe one app.
// This module answers both aliases (`@composition-server-registry` and
// `@composition-machine-registry`) in dev; a release repoints each to its own
// filtered file.
const namespace = runtimeNamespace();
const coreDir = join(import.meta.dir, "../core");
const composition = readSpecComposition(worktreesDir(), namespace);

export const { serverEntries } = (await import(
  selectRegistry(coreDir, namespace, composition, "server")
)) as typeof import("../core/server.generated");
export const { machineEntries } = (await import(
  selectRegistry(coreDir, namespace, composition, "machine")
)) as typeof import("../core/machine.generated");
