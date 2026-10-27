// The deploy receipt: `~/.equin/worktrees/<ns>/build-status.json`, the
// only record of what a build became, and the grammar for reading it back.
//
// It lives in `core/` rather than beside the op commands that write it because
// writing is a CLI act and reading is not. The e2e harness has to prove that
// the deploy answering its target is the build THIS checkout published — a
// comparison against the receipt's `buildId` — and the `e2e` runtime may reach
// a plugin's `core` barrel but never its `cli` one. `cli/build-receipt.ts` is
// now a shim onto this module, so the op commands are untouched by the move.
//
// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the module reaches
// `node:fs` and `paths/core`, whose module scope calls `homedir()`. Nothing in
// `web/` may import it.
//
// `resolveReceipt` — the pure `BuildReceipt | null` → `ResolvedReceipt` kernel
// — is deliberately absent. `resolveBuildReceipt` is what every caller outside
// the module wants, and the co-located test names the kernel by its own path,
// so exporting it here would only widen the surface for no caller.

export {
  writeBuildReceipt,
  readBuildReceipt,
  resolveBuildReceipt,
  interruptedPredecessorWarning,
  reportInterruptedPredecessor,
} from "./internal/build-receipt";
export type {
  BuildReceipt,
  BuildReceiptStatus,
  ResolvedReceipt,
} from "./internal/build-receipt";
