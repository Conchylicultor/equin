// The desktop's native probes (memory, snapshot hash), installed into `core`
// before the graph loads — see `./host-probes`.
import "./host-probes";
// The registry this exec child boots: the namespace's composition, selected at
// runtime by `./plugins-active` (by identity, off the namespace's spec.json).
import {
  serverEntries,
  machineEntries,
  serverComposition,
} from "./plugins-active";

// ── What an `exec` child boots ───────────────────────────────────────────────
//
// `exec` (`../cli/run-exec.ts`) imports this DYNAMICALLY, so that a command
// declaration reaching the exec barrel keeps a trivial static closure (the
// `cli:command-declarations-light` check stops at dynamic-import edges).
//
// Exec only. The serving backend (`./serve.ts`) does not select its registry:
// its entry imports one composition's registries by literal path, so its code
// is a closure a source digest can follow. An exec child is a short-lived CLI
// process that loads fresh code from disk when it starts, outside that
// identity, so selecting here — an import by a computed path — costs nothing.
//
// It lives under `bin/` — beside the files that answer "which app is this
// backend" (`plugins-active`, `select-registry`, `spec-composition`) — because
// `bin/` and `cli/` edges sit outside the server import graph, so `cli/` can
// reach it from here.

export { serverEntries, machineEntries, serverComposition };
