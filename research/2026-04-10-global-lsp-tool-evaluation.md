# LSP Tool Evaluation

## Context

This document records the empirical behavior of the `LSP` tool exposed by the Claude Code harness, tested against the equin codebase on 2026-04-10. It is not a design doc — it is a debugging reference for when the tool misbehaves and we need to know what is "by design", what is a quirk, and what is a real bug.

The motivation was a surprising result during normal use: an initial `findReferences` call on `defineSlot` returned only 2 references in 1 file, while `grep` showed 8 files. That triggered a full audit.

**Environment:** `typescript-language-server@5.1.3` + `typescript@6.0.2` installed via `bun add -g`, binary at `/Users/admin/.bun/bin/typescript-language-server`.

## Tool spec (as loaded)

```
LSP(operation, filePath, line, character)
```

| Field | Type | Notes |
|---|---|---|
| `operation` | enum | One of 9 operations (see below) |
| `filePath` | string | Absolute or relative; relative paths work |
| `line` | integer | 1-based, must be > 0 |
| `character` | integer | 1-based, must be > 0 (schema-enforced) |

Supported operations: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`.

## Per-operation results

All tests run against `plugin-core/` and `plugins/terminal/` files unless noted.

### `hover` ✅
- Returns markdown with type signature, JSDoc, `@version`, `@see` tags.
- Works on local symbols (`defineSlot` at slots.ts:11:17).
- Works on imports from `node_modules` (`useContext` at slots.ts:1:10 — full React JSDoc).
- Position past EOL (col 999) → graceful "No hover information available".
- Position past EOF (line 999) → graceful "No hover information available".
- **Quirk:** the echoed position in success messages can differ from the input. Calling `character: 16` returned `Hover info at 11:8`. The actual hover content was correct; only the displayed coordinate is wrong. Looks like a harness display bug, not an LSP bug.

### `goToDefinition` ✅
- Resolves local references (`Contribution` in slots.ts:3:20 → types.ts:3:13).
- Resolves cross-file `.ts`→`.tsx` (`PluginRuntimeContext` in slots.ts:2:15 → context.tsx:9:14).
- **Resolves path aliases.** `import type { PluginDefinition } from "@core"` in `plugins/terminal/web/index.ts:1:15` → `plugin-core/types.ts:5:18`. Confirms tsconfig path mappings are honored.
- Position not on a symbol → "No definition found".

### `findReferences` ⚠️ lazy
- **Cold call returned only 2 references in 1 file** (the same file as the cursor) for `defineSlot`. Grep confirmed 8 files contain that identifier (3 of which are real code references).
- **After calling `workspaceSymbol` once**, the same `findReferences` call returned 8 references across 3 files — the complete set.
- This is the central operational quirk of this tool. See "Warming behavior" below.
- Includes import statements as references (distinct from `incomingCalls`).

### `documentSymbol` ✅
- Returns nested symbol tree with line numbers and kinds (Function, Constant, Method, Property, Interface, Variable).
- Works on `.tsx` (tested on `web/src/components/ui/sidebar.tsx`, ~80 symbols, deeply nested).
- `line`/`character` parameters are required by schema but **ignored** — the same result is returned regardless of cursor position.

### `workspaceSymbol` ✅ (with caveats)
- Returns **all** symbols in the workspace. In equin: 279 symbols across 36 files.
- `line`/`character` parameters are required by schema but **ignored**. Verified by calling from two different files with two different positions — identical 279-symbol payload.
- **No query parameter.** You cannot filter by name. You always get the whole list. For a large monorepo this could blow context — for equin it's fine.
- **Side effect:** appears to load all workspace files into the TS server's program, which un-laziness `findReferences`, `incomingCalls`, etc. for the rest of the session. This is the warming trick.

### `goToImplementation` ✅
- Works on interfaces, but TypeScript-style: returns every value declared with that interface as its type, not "subclasses" in a Java sense.
- `PluginDefinition` interface (types.ts:5:18) → 7 implementations (every plugin's default export plus the `plugins` array entry in `web/src/plugins.ts`).
- `Slot<P>` interface (slots.ts:6:18) → "no definition found". Probably because `Slot<P>` is a callable interface used only as a return type, not as an annotation on any value. Not a bug — just how the TS server defines "implementation".

### `prepareCallHierarchy` ✅
- Returns the call hierarchy item for a function or method.
- On a non-callable (interface, type) → "No call hierarchy item found at this position". This is correct LSP behavior — call hierarchy is only defined for callables.
- Required as a conceptual prerequisite for `incomingCalls`/`outgoingCalls`, but in this harness you can call those directly with the position; they re-prepare internally.

### `incomingCalls` ✅
- Returns who calls the function at the given position.
- On `defineSlot` (slots.ts:11:17) → 2 callers, identifying 5 distinct call sites:
  - `slots.ts (Module)` — call at 28:9 (the `Core.Root = defineSlot(...)` top-level expression)
  - `plugins/shell/web/slots.ts (Module)` — calls at 5:12, 11:9, 16:12, 22:14
- **Distinct from `findReferences`**: excludes import statements; only counts actual invocations.
- Top-level calls are attributed to a synthetic `Module` caller.

### `outgoingCalls` ✅
- Returns what the function at the given position calls.
- On `defineSlot` → useContributions, useContext (from `web/node_modules/@types/react/index.d.ts`), `map` and `filter` (from the global `lib.es5.d.ts` shipped with the bun-installed typescript).
- Includes calls into `node_modules` and the TypeScript stdlib.

## Warming behavior (the important finding)

The `typescript-language-server` only loads files into its program lazily, as it sees them. Cross-file operations like `findReferences` are silently incomplete until the relevant files are loaded.

The harness exposes **no `didOpen` API and no warm-up call**. Reading a file via the `Read` tool does **not** warm the LSP server — `Read` only touches the filesystem, not the LSP protocol.

**The reliable workaround:** call `workspaceSymbol` once at the start of a session. This appears to load every workspace file into the TS program. After that, `findReferences` / `incomingCalls` / `outgoingCalls` return complete results.

For equin-sized projects this is fine. For very large monorepos it may be too eager and cost a lot of memory in the language server process — at which point the workaround is to manually pre-touch only the files you care about by calling a cheap operation like `documentSymbol` on each.

## Edge cases & error handling

| Input | Result |
|---|---|
| `character: 0` | InputValidationError at schema layer ("must be >0") — confirms 1-based |
| Non-existent file path | Clean error: `File does not exist: <path>` |
| `.md` file | `No LSP server available for file type: .md` |
| `.json` file | `No LSP server available for file type: .json` (note: `tsserver` does support JSON in some configs, but the harness has not wired it up) |
| Relative path (`plugin-core/slots.ts`) | Works identically to absolute |
| Position past EOL | Graceful "no info" — no error |
| Position past EOF | Graceful "no info" — no error |
| Position on whitespace adjacent to a symbol | Often still resolves (TS server is permissive) |

The TypeScript server is the only one configured. Python (`.py`), Go (`.go`), and JSON files would all return "No LSP server available". equin's future `cli/` (Python) and `gateway/` (Go) directories will need additional servers configured in the harness if we want LSP support there.

## Quirks worth flagging

1. **Display bug**: `hover` echoes the wrong column in success messages (off by ~8 in the case observed). The hover content itself is correct; only the displayed `line:character` in the response prefix is wrong.
2. **Required-but-ignored params**: `documentSymbol` and `workspaceSymbol` require `line`/`character` but ignore them. Pass `1, 1` as a convention.
3. **No query for `workspaceSymbol`**: returns the full workspace symbol table every time. No way to filter by name from the tool surface — you'd need to filter the response in the calling code.
4. **Implicit server lifecycle**: no init, no shutdown, no health check. If the server crashes mid-session there is no signal — operations will likely just start returning empty/lazy results.
5. **Lazy `findReferences` is silent**: there is no warning that the result may be incomplete. If you don't know about the warming trick, you will get wrong answers and not realize it. **This is the most dangerous behavior** of the tool.

## Practical recommendation for sessions that use LSP

1. At the start of any session that will use LSP for cross-file operations, run `workspaceSymbol` once. Treat its 279-symbol payload as throwaway warmup — you don't need to read it.
2. For "find all usages of X" questions, prefer `findReferences` over `grep` once warmed; it filters out comments, strings, and unrelated identifiers.
3. For "is X used anywhere at all" questions, `grep` is still faster and doesn't require warmup.
4. Use `incomingCalls` (not `findReferences`) when you specifically want call sites and not import statements.
5. Use `goToImplementation` to find all values typed as an interface — useful for plugin discovery (e.g., finding every `PluginDefinition` in this repo).
6. Don't trust the echoed position in `hover` responses; trust the type signature in the body.

## Verification

To re-verify any of this in the future, the diagnostic sequence is:

```
1. LSP hover plugin-core/slots.ts 11 17        → expect: function defineSlot<P>(...)
2. LSP findReferences plugin-core/slots.ts 11 17  → expect: 2 refs / 1 file (lazy)
3. LSP workspaceSymbol plugin-core/slots.ts 1 1   → expect: ~279 symbols
4. LSP findReferences plugin-core/slots.ts 11 17  → expect: 8 refs / 3 files (warmed)
```

If step 2 already returns 8 refs without step 3, something has changed: either the harness now warms eagerly, or it has been wired up to call `didOpen` on Read. Worth knowing.

If step 3 returns dramatically fewer than 279 symbols, the workspace probably has new tsconfig issues or path-alias breakage — `goToDefinition` on a `@core` import is the next thing to test.
