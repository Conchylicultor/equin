# No Cross-Plugin Re-Exports Check

## Context

CLAUDE.md documents a rule: "No cross-plugin re-exports — import the source barrel directly, never proxy another plugin's symbols through your own barrel." This rule is not enforced by any check today. The `plugin-boundaries` check enforces barrel purity (R3) — it verifies that barrels only contain imports, re-exports, type aliases, and a single default export — but it never inspects the `from` specifier to verify the re-export source is internal to the plugin. A barrel like `export { Foo } from "@plugins/other/web"` passes all current checks.

We want to enforce this rule in a way that's reusable for future barrel-source rules.

## Approach: extend `checkBarrelPurity` to be source-aware

**File:** `cli/src/checks/plugin-boundaries.ts`

The change is small and surgical — extend the existing barrel purity function to also validate re-export sources, rather than adding a separate check pass.

### 1. Widen `checkBarrelPurity` signature

Add `pluginPath` and `pluginSet` parameters so the function can determine whether a re-export targets another plugin:

```typescript
function checkBarrelPurity(
  absPath: string,
  relPath: string,
  violations: Violation[],
  pluginPath: string,       // NEW: owning plugin's relPath (e.g. "conversations/plugins/conversation-view")
  pluginSet: Set<string>,   // NEW: all known plugin paths
)
```

Update the call site (lines 90–98) to pass `p.relPath` and `pluginSet`.

### 2. Switch from `stripCommentsAndStrings` to `stripComments`

Currently `checkBarrelPurity` uses `stripCommentsAndStrings` (line 382) which blanks string contents — making `from` specifiers invisible. Switch to `stripComments` which preserves string-literal contents.

This is safe because:
- `isAllowedBarrelStatement` only inspects statement prefixes (`s.startsWith(...)`) and never looks at string contents
- `splitTopLevelStatements` splits on `;` and `}` at depth 0 — module specifiers don't contain these characters
- Barrel files are small; performance is not a concern

### 3. Add the re-export source check

After the existing purity checks, for each statement that passed `isAllowedBarrelStatement`, extract the `from` specifier and validate it. Add a helper:

```typescript
function extractFromSpecifier(stmt: string): string | null {
  const m = stmt.match(/from\s+["']([^"']+)["']\s*$/);
  return m ? m[1]! : null;
}
```

Then in `checkBarrelPurity`, after the existing purity loop body:

```typescript
if (isAllowedBarrelStatement(trimmed)) {
  // NEW: check re-export sources
  const specifier = extractFromSpecifier(trimmed);
  if (specifier?.startsWith("@plugins/")) {
    const resolved = resolveImport(specifier, pluginSet);
    if (resolved && resolved.pluginPath !== pluginPath) {
      violations.push({
        rule: "cross-plugin-reexport",
        file: `${relPath}:${line}`,
        message: `barrel re-exports from another plugin: \`${specifier}\``,
        fix: "import the source barrel directly — never proxy another plugin's symbols through your own barrel. Consumers should `import { … } from \"" + specifier + "\"` themselves.",
      });
    }
  }
  continue;
}
```

This catches all forms: `export { X } from "@plugins/..."`, `export type { X } from "@plugins/..."`, and hypothetical `import ... from "@plugins/..."` (which would be caught for completeness, though imports aren't re-exports by themselves — the concern is only export-from).

To be precise, only flag `export ... from` statements, not plain `import` statements (importing from another plugin in a barrel is fine — it's the re-export that's the problem). Refine the check:

```typescript
if (isAllowedBarrelStatement(trimmed) && trimmed.startsWith("export ")) {
  const specifier = extractFromSpecifier(trimmed);
  // ...
}
```

### 4. Update the check description

Update the `description` field on the `pluginBoundaries` check object (line 68) to mention the new rule:

```
"Plugin module boundaries: barrel purity, cross-plugin import grammar, no cross-plugin re-exports, DAG, package naming"
```

## Why this is reusable

The approach — passing plugin context into the barrel purity checker and parsing `from` specifiers — is a general pattern for any "barrel may only reference X" rule. Future rules would add more conditions in the same location:

- "Barrels may only re-export from own subtree" (not from parent plugins)
- "Barrels may not re-export from `@packages/...`"
- "Barrels may not re-export from `node_modules`"

All would use the same `extractFromSpecifier` + `resolveImport` pattern.

## Files to modify

- `cli/src/checks/plugin-boundaries.ts` — the only file changed

## Verification

1. `./equin check --plugin-boundaries` — should pass (no existing violations)
2. Temporarily add `export { defineSlot } from "@plugins/shell/web"` to any barrel → check should fail with `[cross-plugin-reexport]`
3. Verify the existing barrel-purity checks still work (add a `const x = 1` to a barrel → still caught)
4. Full `./equin check` should pass
