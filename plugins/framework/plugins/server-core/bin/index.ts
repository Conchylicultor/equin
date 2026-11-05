// DO NOT EDIT — a composition backend's serving entry, rendered by codegen's
// `renderBackendEntry` (plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts).
// The main composition's is the committed `bin/index.ts`, held equal to the
// render by `server-core:backend-entry-in-sync`; any other composition's is the
// gitignored `bin/index.composition.<id>.generated.ts` its build writes.
//
// Its registries are imported by LITERAL path, so the code this backend runs is
// a closure `sourceDigest` can follow. WHICH app it is was decided by the entry
// the spec's `command` runs (`backendEntryFor`, infra/paths); `serve` checks
// that against the spec's `composition` before it binds anything.

// FIRST, and it must stay first: this declares the namespace this backend
// serves, from the `--namespace` the gateway spawned it with. Everything below
// reads that answer, and modules in the closure resolve it at module eval
// (`config_v2`'s config dir), so an import above this line boots the process
// without an identity. See `./declare-namespace`.
import "./declare-namespace";
import "./pin-toolchain";
import * as server from "../core/server.generated";
import * as machine from "../core/machine.generated";
import { serve } from "./serve";

await serve({ server, machine });
