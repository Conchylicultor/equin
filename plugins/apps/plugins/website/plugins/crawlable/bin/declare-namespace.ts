import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";

// ── The FIRST thing the take does: say which namespace it is ────────────────
//
// Imported as the literal first statement of `./static-host.ts`, before any
// portable server barrel is evaluated — the rule every host entry follows
// (`server-core/bin/declare-namespace.ts`, the workspace demo's
// `bin/declare-namespace.ts`). A static host is no gateway namespace: it runs
// as the composition whose pages it renders, named by the take's first
// argument.
const composition = process.argv[2];
if (composition === undefined) {
  throw new Error(
    "usage: static-host.ts <composition> <out-dir> <cluster-file>",
  );
}
declareRuntimeNamespace(asNamespace(composition));
