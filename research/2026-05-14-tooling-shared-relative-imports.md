# Reverse `shared/` import convention: relative paths instead of aliases

## Context

The plugin boundary system currently enforces two rules around `shared/` directories:

1. **R3 (barrel-required)** — every `shared/` with `.ts` files must have `index.ts`
2. **R12 (relative-into-shared)** — relative `../shared` imports are forbidden; must use `@plugins/<name>/shared`

These rules were introduced to funnel shared imports through the barrel system. In practice, most plugins don't even use the barrel — 24 of 37 `shared/index.ts` files have zero barrel-level imports (everything goes through deep paths like `@plugins/foo/shared/types`). The `@plugins/` alias is unnecessary overhead since `shared/` is plugin-private and never imported cross-plugin.

**New convention:** plugins import their own `shared/` via relative paths (`../shared/types`). The alias form (`@plugins/<name>/shared`) is forbidden for shared. The barrel file is no longer required.

The restriction that remains: `shared/` is only importable by `web/`, `server/`, and `central/` within the **same** plugin — not parents, not children, not `core/`.

## Changes

### 1. Modify `plugin-boundaries.ts`

**File:** `tooling/src/checks/plugin-boundaries.ts`

**a) Remove `shared` from barrel-required (R3, line 111)**

Change the runtime loop from:
```ts
for (const runtime of ["web", "server", "central", "core", "shared"] as const)
```
to:
```ts
for (const runtime of ["web", "server", "central", "core"] as const)
```

`shared/index.ts` is no longer required. Plugins that have one can keep it (harmless), but the check won't demand it.

**b) Remove R12 (relative-into-shared, lines 175–198)**

Delete the entire R12 block that forbids relative imports into `shared/`.

**c) Add new rule: forbid `@plugins/<name>/shared` intra-plugin imports**

In the intra-plugin early-return section (around line 225–226), before `continue`, add a check: if the import targets `shared` via the alias form and the source is in the same plugin, flag it as a violation with fix suggesting the relative form.

```ts
// Intra-plugin imports (source is the same plugin) are unrestricted,
// EXCEPT: shared/ must use relative paths, not the alias.
if (sourcePlugin === resolved.pluginPath) {
  if (resolved.suffixHead === "shared") {
    violations.push({
      rule: "shared-use-relative",
      file: relFile,
      message: `use a relative import instead of \`${imp.path}\``,
      fix: `shared/ is plugin-private — import via \`../shared${resolved.tail ? "/" + resolved.tail : ""}\` instead of the @plugins alias`,
    });
  }
  continue;
}
```

**d) Add new rule: shared/ only importable from web/, server/, central/**

After the R8 (relative-cross-plugin) block, add a check for relative imports into `shared/` from disallowed runtimes (core/, lint/, check/). This catches intra-plugin relative imports from wrong runtimes:

```ts
// R13: shared/ is only importable from web/, server/, central/ within the same plugin.
if (sourcePlugin) {
  const sourceRuntime = runtimeForPath(relFile, pluginSet);
  if (sourceRuntime && sourceRuntime !== "web" && sourceRuntime !== "server" && sourceRuntime !== "central" && sourceRuntime !== "shared") {
    const sharedPrefix = `plugins/${sourcePlugin}/shared`;
    for (const relImp of extractRelativeImports(src)) {
      const resolvedAbs = resolve(dirname(absFile), relImp);
      const resolvedRel = relative(root, resolvedAbs).split(sep).join("/");
      if (resolvedRel === sharedPrefix || resolvedRel.startsWith(sharedPrefix + "/")) {
        violations.push({
          rule: "shared-wrong-runtime",
          file: relFile,
          message: `\`${sourceRuntime}/\` cannot import from shared/ — only web/, server/, central/ may`,
          fix: `move the needed types/utils to \`core/\` if they must be shared with \`${sourceRuntime}/\``,
        });
      }
    }
  }
}
```

Also handle the alias form in the intra-plugin section (from step c) — if the source runtime is not web/server/central and the target is shared, flag it:

```ts
if (sourcePlugin === resolved.pluginPath) {
  if (resolved.suffixHead === "shared") {
    const sourceRuntime = runtimeForPath(relFile, pluginSet);
    if (sourceRuntime && sourceRuntime !== "web" && sourceRuntime !== "server" && sourceRuntime !== "central" && sourceRuntime !== "shared") {
      violations.push({
        rule: "shared-wrong-runtime",
        file: relFile,
        message: `\`${sourceRuntime}/\` cannot import from shared/ — only web/, server/, central/ may`,
        fix: `move the needed types/utils to \`core/\` if they must be shared with \`${sourceRuntime}/\``,
      });
    } else {
      violations.push({
        rule: "shared-use-relative",
        file: relFile,
        message: `use a relative import instead of \`${imp.path}\``,
        fix: `shared/ is plugin-private — import via \`../shared${resolved.tail ? "/" + resolved.tail : ""}\` instead of the @plugins alias`,
      });
    }
  }
  continue;
}
```

### 2. Write cleanup script

**File:** `tooling/src/checks/scripts/fix-shared-to-relative.ts`

Replaces the old `fix-relative-into-shared.ts` (delete that file).

The script:
1. Walks all `.ts`/`.tsx` files in `plugins/`, `web/src/`, `server/src/`, `central/src/`
2. For each file, finds `@plugins/<name>/shared` or `@plugins/<name>/shared/<deep>` imports where `<name>` matches the file's own plugin
3. Computes the correct relative path from the source file to the `shared/` directory
4. Rewrites the import specifier in-place
5. After rewriting, finds `shared/index.ts` files that are no longer imported by anyone (neither via alias nor relative) and deletes them

Key logic for computing relative paths:
- Source: `plugins/foo/web/components/bar.tsx`
- Target: `@plugins/foo/shared/types`
- Plugin root: `plugins/foo/`
- Relative from source dir to `shared/types`: `../../shared/types`

Uses `path.relative(dirname(sourceFile), pluginSharedDir)` to compute the correct `../` chain, then appends the deep path suffix.

### 3. Delete old script

**File to delete:** `tooling/src/checks/scripts/fix-relative-into-shared.ts`

This script did the opposite of what we now want.

### 4. Update CLAUDE.md references

Search for references to R12 / "relative-into-shared" in documentation and update the rule description. The `CLAUDE.md` barrel description already says "shared/ is plugin-private" which stays correct.

## Verification

1. Run the cleanup script: `bun tooling/src/checks/scripts/fix-shared-to-relative.ts --dry-run` to preview changes
2. Run without `--dry-run` to apply
3. Run `./equin check --plugin-boundaries` to verify zero violations
4. Run `./equin build` to verify TypeScript compilation and full build
5. Spot-check a few rewritten imports to confirm paths are correct
