# ConfigStore Abstraction + JSONC Backend

## Context

The current config system stores values in Postgres (per-worktree `config` table). Config v2 moves to human-readable JSONC files at `~/.singularity/config/`, editable by UI, text editors, and agents. The **ConfigStore** is the storage abstraction that decouples reading/writing config from a specific backend — the first implementation is JSONC-on-disk, but the interface is the seam for future backends (cloud sync, multi-user).

This lives in a new `config_v2/` umbrella plugin, with the store as a self-contained sub-plugin at `config_v2/plugins/store/`. The umbrella will host future sub-plugins (merge, migration, codegen) as the v2 system grows.

## Plugin Structure

```
plugins/config_v2/
  package.json              # umbrella metadata
  plugins/
    store/
      package.json          # sub-plugin metadata
      core/
        index.ts            # barrel: ConfigStore, JsonValue, Disposable
        internal/
          types.ts          # interface + type definitions
      server/
        index.ts            # ServerPluginDefinition (onReady/onShutdown, exports getConfigStore)
        internal/
          jsonc-store.ts    # JsoncConfigStore class implementation
```

## Design

### Interface (`plugins/config_v2/plugins/store/core/internal/types.ts`)

```ts
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Disposable {
  dispose(): void;
}

export interface ConfigStore {
  read(path: string): Promise<JsonValue | undefined>;
  write(path: string, value: JsonValue): Promise<void>;
  watch(path: string, cb: (value: JsonValue | undefined) => void): Disposable;
  list(): Promise<string[]>;
}
```

- `path` is a relative store path like `conversations/conversation-category/categories.jsonc`
- `read` returns `undefined` when the file is missing or unparseable (graceful degradation)
- `write` creates parent dirs, formats with 2-space indent, uses atomic rename
- `watch` calls `cb` immediately with the current value (seed read), then on every change; returns a `Disposable` to unsubscribe
- `list` returns relative paths of all `.jsonc` files, excluding `.applied/`

### JSONC Implementation (`plugins/config_v2/plugins/store/server/internal/jsonc-store.ts`)

A `JsoncConfigStore` class implementing `ConfigStore`. Key mechanics:

**Atomic writes (secrets store pattern):**
- Module-level `writeChain` serializes all mutations
- Each write goes to a temp file (`${path}.tmp-${randomUUID()}`) then `rename()` atomically
- On failure: `unlink(tmp)` then rethrow

**File watching (git-watcher pattern):**
- Single `@parcel/watcher` subscription on `CONFIG_DIR` (lazy — starts on first `watch()` call)
- Per-path dispatch via `Map<absolutePath, Set<callback>>`
- Double-timer debounce: `DEBOUNCE_MS=100` + `CEILING_MS=1000` safety ceiling
- 30s reconcile interval as safety net
- Torn down via `shutdown()`

**Path traversal guard:**
- `resolvePath()` ensures the resolved absolute path starts with `configDir + sep` — rejects `../../` escapes

**No in-memory read cache:**
- File reads are cheap; consumers who need caching use `watch()` to maintain their own copy
- Avoids duplicating cache invalidation logic that `watch()` already handles

### Server Plugin (`plugins/config_v2/plugins/store/server/index.ts`)

The `ServerPluginDefinition` owns the lifecycle:
- `onReady`: instantiate `JsoncConfigStore` with `CONFIG_DIR`, store as module-level singleton
- `onShutdown`: tear down watcher subscription
- Named export: `getConfigStore(): ConfigStore` (throws if not initialized)

## Files

### Create

| File | Purpose |
|------|---------|
| `plugins/config_v2/package.json` | Umbrella metadata (description only) |
| `plugins/config_v2/plugins/store/package.json` | Sub-plugin metadata |
| `plugins/config_v2/plugins/store/core/index.ts` | Barrel: `ConfigStore`, `JsonValue`, `Disposable` |
| `plugins/config_v2/plugins/store/core/internal/types.ts` | Interface + type definitions |
| `plugins/config_v2/plugins/store/server/index.ts` | `ServerPluginDefinition` + `getConfigStore` export |
| `plugins/config_v2/plugins/store/server/internal/jsonc-store.ts` | `JsoncConfigStore` implementation |

### Modify

| File | Change |
|------|--------|
| `plugins/infra/plugins/paths/server/internal/paths.ts` | Add `CONFIG_DIR = join(SINGULARITY_DIR, "config")` |
| `plugins/infra/plugins/paths/server/index.ts` | Re-export `CONFIG_DIR` |
| `package.json` (root) | Add `"jsonc-parser": "^3.3.1"` to dependencies |
| `server/src/plugins.ts` | Register the store plugin |

## Implementation Order

1. Add `CONFIG_DIR` to paths plugin (2 files)
2. Add `jsonc-parser` dependency to root `package.json`
3. Create umbrella `plugins/config_v2/package.json`
4. Create `plugins/config_v2/plugins/store/core/` — interface types + barrel
5. Create `plugins/config_v2/plugins/store/server/internal/jsonc-store.ts` — full implementation
6. Create `plugins/config_v2/plugins/store/server/index.ts` — plugin definition + export
7. Register in `server/src/plugins.ts`

## Verification

1. `bun install` — confirms `jsonc-parser` resolves
2. `./equin build` — confirms type-checking passes, server starts
3. Manual test via MCP `query_db` or a quick script:
   - Write: `getConfigStore().write("test/hello.jsonc", { greeting: "world" })`
   - Read: `getConfigStore().read("test/hello.jsonc")` → `{ greeting: "world" }`
   - Verify file exists at `~/.singularity/config/test/hello.jsonc` with 2-space indent
   - List: `getConfigStore().list()` → includes `"test/hello.jsonc"`
   - Watch: subscribe, edit file externally, confirm callback fires
   - Missing file: `getConfigStore().read("nonexistent.jsonc")` → `undefined`
   - Bad JSONC: write garbage to a `.jsonc` file, confirm `read()` returns `undefined` (not crash)
4. `./equin check` — all existing checks still pass
