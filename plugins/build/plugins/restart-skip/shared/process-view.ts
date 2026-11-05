import { isAbsolute, join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import type { ProcessView } from "./judge";

// Read at the first module eval of this file — the process start is fixed by
// then, and nothing later can move it.
const STARTED_AT_MS = performance.timeOrigin;

/**
 * The files Bun reads once at start and resolves every later import by,
 * relative to the checkout: the `@plugins/*` paths (tsconfig), the runtime
 * config, the root package.json (workspaces). A change to any of them
 * re-aims a lazy import of this process differently from a fresh one's.
 */
const RUNTIME_INPUTS = [
  "tsconfig.json",
  "tsconfig.base.json",
  "bunfig.toml",
  "package.json",
];

/** The running process (a backend, or central), as the judgement reads it. */
export function currentProcessView(
  host: Pick<ProcessView, "bootInputs" | "children" | "closureSince">,
): ProcessView {
  return {
    startedAtMs: STARTED_AT_MS,
    bin: process.execPath,
    entry: Bun.main,
    // Every module this process's loader has evaluated, eager and lazy, by
    // real path (the entry itself is not among them; the closure walk
    // starts from it).
    loaded: Object.keys(require.cache).filter((k) => isAbsolute(k)),
    runtimeInputs: RUNTIME_INPUTS.map((f) => join(REPO_ROOT, f)),
    ...host,
  };
}
