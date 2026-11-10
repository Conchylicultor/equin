// The lockfile as far as installed npm code can tell: what decides which
// package versions a process loads, and nothing about which workspace plugins
// exist. Read by every cache keyed on npm code — the type-check pass (its
// compiler and lint engines), the browser host snapshot's address and every
// plugin record's key (plugin-records' `npmResolutionsKey`) — each hashing it
// with its own hasher. A leaf with no imports, so a record producer that keys
// on it gains one module, not the npm barrel's closure.

/**
 * The lockfile's npm resolutions, as text to hash: its content minus the top-level
 * `"workspaces"` section, minus every `@workspace:` package line, minus blank
 * lines. What is left is the npm resolutions (and overrides, patches) — which
 * version of every npm package is installed.
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
export function lockfileNpmResolutions(text: string): string {
  const lines = text.split("\n");
  if (!lines.includes('  "workspaces": {')) return text;
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
  return kept.join("\n");
}
