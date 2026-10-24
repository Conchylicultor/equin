# Config V2 — Three-Tier Implementation Plan

## Context

The current config_v2 system stores user values in `~/.singularity/config/` as flat JSONC files. There's no way for agents to commit config defaults to git, no conflict detection when defaults change, and no separation between "team defaults" and "user customization." Only one plugin (`build`) uses config_v2 today.

This plan adds two additional tiers (code defaults → git committed → user local) with hash-based conflict detection at each boundary, using a `ConfigProxy` abstraction that can be swapped to cloud storage later.

## Tier Layout

```
Code (defineConfig defaults)
  ↓ ./equin build
Git committed: config/<hierarchy>/<name>.origin.jsonc    (auto-generated)
               config/<hierarchy>/<name>.jsonc            (agent overwrites, optional)
  ↓ server start
User local:    ~/.singularity/config/<hierarchy>/<name>.origin.jsonc  (auto-copied)
               ~/.singularity/config/<hierarchy>/<name>.jsonc         (user overwrites, optional)
```

Overwrites are **full copies** (not deltas). Each carries a `// @hash` of the origin it was derived from. Effective config = overwrites if exists, else origin.

## New Abstractions

### ConfigProxy (`config_v2/core/internal/config-proxy.ts`)

```ts
interface ConfigProxy {
  read(): { content: JsonValue; hash: string | null } | null;
  write(content: JsonValue, hash: string | null): void;
  exists(): boolean;
}
function computeHash(content: JsonValue): string  // sha256, 12 hex chars
function codeConfigProxy(descriptor: ConfigDescriptor): ConfigProxy  // read-only defaults
function jsoncConfigProxy(filePath: string): ConfigProxy  // JSONC on disk, hash in // @hash line
```

Lives in `core/` because both build tooling and server need it (core has no server/browser deps).

### Tier Logic (`config_v2/core/internal/tier-logic.ts`)

```ts
function effective(origin: ConfigProxy, overwrites: ConfigProxy): JsonValue
function hasConflict(origin: ConfigProxy, overwrites: ConfigProxy): boolean
function propagate(upstream: ConfigProxy, downOrigin: ConfigProxy, downOverwrites: ConfigProxy): { conflict: boolean }
function readTypedConfig<F>(descriptor: ConfigDescriptor<F>, origin: ConfigProxy, overwrites: ConfigProxy): ConfigValues<F>
```

Pure functions. `readTypedConfig` calls `effective()` then `descriptor.schema.safeParse()`, falls back to defaults.

## JSONC File Format

```jsonc
// @hash a1b2c3d4e5f6
{
  // Auto-build on push
  "autoBuild": true
}
```

Origin files: hash = hash of own content (integrity). Overwrites: hash = hash of the origin they were copied from (conflict detection). `jsoncConfigProxy.read()` extracts `// @hash` from line 1 before parsing.

## Implementation Steps

### Phase 1: Core Abstractions

**1a.** Create `plugins/config_v2/core/internal/config-proxy.ts`
- `ConfigProxy` interface
- `computeHash()` — `createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 12)`
- `codeConfigProxy(descriptor)` — read-only, returns `{ content: defaults, hash: null }`
- `jsoncConfigProxy(filePath)` — reads/writes JSONC with `// @hash` header, atomic writes (reuse pattern from `jsonc-store.ts`)

**1b.** Create `plugins/config_v2/core/internal/tier-logic.ts`
- `effective()`, `hasConflict()`, `propagate()`, `readTypedConfig()`

**1c.** Update `plugins/config_v2/core/index.ts` — export new symbols

### Phase 2: Build-Time Codegen

**2a.** Create `tooling/src/config-origin-gen.ts`

Discovery: mirrors `enrichPluginTreeDocs` in `tooling/src/docgen.ts`.
1. `registerBarrelStubs(root)` + `buildPluginTree(pluginsRoot)`
2. For each node with `server/index.ts`, import barrel, access `mod.default.contributions`
3. Duck-type filter: entries with `.descriptor` having `.name`, `.fields`, `.defaults`
4. For each: write `config/<node.hierarchyId>/<descriptor.name>.origin.jsonc` using `codeConfigProxy` + `propagate()`

Comment generation: iterate `descriptor.fields`, prepend `// <field.meta.description>` per key.

```ts
export async function generateConfigOrigins(opts: { root: string }): Promise<void>
export async function renderConfigOriginContent(opts: { root: string }): Promise<Map<string, string>>
```

**2b.** Add to `cli/src/commands/build.ts` — after `generatePluginDocs` (step 4), before checks:
```ts
const { generateConfigOrigins } = await import("@tooling/config-origin-gen");
await generateConfigOrigins({ root });
```

**2c.** Create `config/CLAUDE.md` — compact agent-facing doc (see bottom of this plan).

### Phase 3: In-Sync Check

**3a.** Create `tooling/src/checks/config-origins-in-sync.ts`
- Calls `renderConfigOriginContent()`, compares against disk
- Also validates: every overwrites `@hash` matches its origin's content hash
- Fails on drift or unresolved conflicts

**3b.** Register in `tooling/src/checks/index.ts` CHECKS array.

### Phase 4: Server Integration

**4a.** Refactor `plugins/config_v2/server/internal/registry.ts` `initRegistry()`:

For each contribution:
1. Build 5 proxies: `code`, `gitOrigin`, `gitOverwrites`, `userOrigin`, `userOverwrites`
   - Paths: `REPO_ROOT` from `@plugins/infra/plugins/paths/server` for git tier, `CONFIG_DIR` for user tier
2. **Propagate** git→user: compute `gitEffective = effective(gitOrigin, gitOverwrites)`, wrap as readonly proxy, `propagate(gitEffectiveProxy, userOrigin, userOverwrites)`. Log warning on conflict.
3. **Read effective**: `readTypedConfig(descriptor, userOrigin, userOverwrites)` → cache
4. **Watch** both user origin and user overwrites paths via `getConfigStore().watch()`

**4b.** Refactor `setConfig()`:
- If no user overwrites exists: copy user origin content + hash → create overwrites
- Mutate field in overwrites content
- Write via `jsoncConfigProxy` (preserving the hash)

### Phase 5: Verify

1. `./equin build` → generates `config/build/config.origin.jsonc`
2. `getConfig(buildConfig)` on server still returns correct values
3. In-sync check passes
4. Manual test: create `config/build/config.jsonc` with `{ "autoBuild": false }` + matching hash → server reads `false`
5. Manual test: change a default in code, rebuild → origin hash changes, check fails if overwrites exist with old hash

## Critical Files

| File | Role |
|---|---|
| `plugins/config_v2/core/internal/config-proxy.ts` | **New** — ConfigProxy, computeHash, factories |
| `plugins/config_v2/core/internal/tier-logic.ts` | **New** — effective, propagate, readTypedConfig |
| `plugins/config_v2/core/index.ts` | **Modify** — add exports |
| `plugins/config_v2/server/internal/registry.ts` | **Modify** — tier-aware init, setConfig |
| `tooling/src/config-origin-gen.ts` | **New** — build-time codegen |
| `tooling/src/checks/config-origins-in-sync.ts` | **New** — check |
| `tooling/src/checks/index.ts` | **Modify** — register check |
| `cli/src/commands/build.ts` | **Modify** — add codegen step |
| `config/CLAUDE.md` | **New** — agent doc |
| `plugins/infra/plugins/paths/server/internal/paths.ts` | Read-only — `REPO_ROOT`, `CONFIG_DIR` |
| `tooling/src/docgen.ts` | Read-only — reference pattern for barrel import |
| `plugins/config_v2/plugins/store/server/internal/jsonc-store.ts` | Read-only — reuse atomicWrite pattern |

## config/CLAUDE.md Content

```
# Config

Git-committed config defaults and overrides for plugins using `defineConfig` (config v2).

## Files

- `<plugin-path>/<name>.origin.jsonc` — auto-generated defaults. Do not edit. Regenerated by `./equin build`.
- `<plugin-path>/<name>.jsonc` — team overrides (optional). Copy from origin, edit values, commit.

The `// @hash` on line 1 tracks which origin version the overrides are based on. Preserve it.

## Editing

1. Run `./equin build` to generate/update origin files.
2. To override defaults: copy `xxx.origin.jsonc` → `xxx.jsonc`, edit values, keep the `// @hash` line.
3. When origin changes (new defaults), `config-in-sync` check fails. Update overrides and set `// @hash` to the new origin hash.

User-local overrides live in `~/.singularity/config/` with the same structure (never committed).
```
