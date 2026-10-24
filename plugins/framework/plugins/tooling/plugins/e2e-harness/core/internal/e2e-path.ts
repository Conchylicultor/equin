import { MODULE_EXTENSION } from "@plugins/framework/plugins/tooling/plugins/guards/core";

/**
 * Does this repo-relative path follow the e2e-script convention —
 * `plugins/<path>/e2e/<name>.ts` (root CLAUDE.md, "Driving the app")?
 *
 * The ONE thing that turns a `./equin run <path>` into an `e2e` op: the
 * run command takes the host grant, plants the op marker and writes the op-log
 * record for a script this says yes to, and runs every other script exactly as
 * before. The harness plugin owns the convention, so it owns the predicate;
 * `test-layout` owns a different split (`*.test.ts` bun vs jsdom) and is not
 * where this belongs.
 *
 * A leaf: no `node:*`, so `cli`, `core` and `web` may all read it.
 */
export function isE2eScriptPath(repoRelPath: string): boolean {
  const p = repoRelPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p.startsWith("plugins/")) return false;
  if (!MODULE_EXTENSION.test(p)) return false;
  return p.split("/").slice(0, -1).includes("e2e");
}
