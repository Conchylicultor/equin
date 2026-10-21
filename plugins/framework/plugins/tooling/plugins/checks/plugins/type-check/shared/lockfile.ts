// The lockfile as far as types and lint rules can tell — shared by the lint
// rule groups' engine (`../check/lint-groups.ts`) and the compiler's engine
// (`./tsc-engine.ts`): both depend on which npm packages are installed, and
// neither on which workspace plugins exist.

import { createHash } from "crypto";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The lockfile as far as linting can tell: its content minus the top-level
 * `"workspaces"` section, minus every `@workspace:` package line, minus blank
 * lines. What is left is the npm resolutions (and overrides, patches) — what
 * decides which parser, plugins and `@types` the rules run against.
 *
 * Adding a plugin with a `package.json` adds a workspace entry and nothing
 * else; that was every one of the 37 lockfile edits on main in the week this
 * was written, and each of them re-linted the whole repo.
 *
 * bun writes this file in one deterministic text layout, which is what lets the
 * filter work by line. A layout it does not recognise (no `"workspaces"` opener
 * at the expected indent) hashes the whole file: the cost of a wrong guess is
 * then an over-invalidation, never a stale result.
 */
export function lockfileLintDigest(text: string): string {
  const lines = text.split("\n");
  if (!lines.includes('  "workspaces": {')) return sha256(text);
  const kept: string[] = [];
  let inWorkspaces = false;
  for (const line of lines) {
    if (inWorkspaces) {
      if (line === "  },") inWorkspaces = false;
      continue;
    }
    if (line === '  "workspaces": {') {
      inWorkspaces = true;
      continue;
    }
    if (line.trim() === "" || line.includes("@workspace:")) continue;
    kept.push(line);
  }
  return sha256(kept.join("\n"));
}
