# Vendor the `@parcel/watcher` native addon into self-contained releases

## Context

A self-contained release (`./equin release`, which `bun build --compile`s the
backend) crashes at boot:

```
[plugin.infra.git-watcher] onReady failed
error: Cannot require module ./build/Release/watcher.node
```

`bun build --compile` **cannot bundle native `.node` addons**. `@parcel/watcher@2.5.6`
ships its native binding as a separate per-platform optional-dependency package
(`@parcel/watcher-darwin-arm64/watcher.node`, etc.). At runtime its `index.js` does:

```js
try { binding = require(`@parcel/watcher-${platform}-${arch}`); }   // 1) platform pkg — fails in the compiled binary
catch { try { binding = require('./build/Release/watcher.node'); }   // 2) dead path in 2.5.6 (no build/ dir ships)
        catch { ... } }
```

In the compiled binary step 1 fails (the addon isn't bundled and isn't on disk),
so it falls through to the non-existent `./build/Release/watcher.node` — the error
the user sees. `infra/git-watcher` is load-bearing and starts a watcher
unconditionally on boot via `createFileWatcher`, so **every** release that includes
it crashes.

This is the same class of gap already solved for migration SQL files and the
embedded-Postgres / PgBouncer natives: things `bun --compile` can't embed are
**vendored as files** next to the binary and located at runtime via an env var the
launcher sets before any path-dependent import. We mirror that proven pattern here.

The existing lazy-load mitigation in `create-file-watcher.ts` only *defers* the
crash to first watcher start; it never vendors the addon. This plan vendors it.

### Second consumer (latent release crash)

`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts:1`
does a **static** top-level `import parcel from "@parcel/watcher"` and calls
`parcel.subscribe` directly — bypassing the file-watcher chokepoint. In a release
this would eager-load the addon at barrel-init time (an even earlier crash) and
would not honor the env redirect. We reroute it through the single loader and add a
lint rule so this footgun can't recur.

## Approach

Three coordinated parts (mirroring `SINGULARITY_MIGRATIONS_DIR`), plus structural
hardening so the whole class of bug is closed.

### 1. file-watcher: one env-aware loader, exported as the single chokepoint

`plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`

- Add a top-level **value** import of `@parcel/watcher`'s pure-JS wrapper (safe — it
  loads no native code, only defines functions):
  ```ts
  import { createWrapper } from "@parcel/watcher/wrapper";
  ```
  (Verified: `@parcel/watcher@2.5.6` has `main: index.js` and **no `exports` field`,
  so the deep import resolves; `wrapper.js` exports `createWrapper`, which returns
  `{ writeSnapshot, getEventsSince, subscribe, unsubscribe }` — a drop-in for the
  public API; the file-watcher only uses `.subscribe`.)
- Replace `loadParcelWatcher()` with an env-aware version:
  ```ts
  function loadParcelWatcher(): Promise<typeof import("@parcel/watcher")> {
    parcelWatcherPromise ??= (async () => {
      const nodePath = process.env.SINGULARITY_PARCEL_WATCHER_NODE;
      if (nodePath) {
        // Release: the native addon isn't bundled into the compiled binary.
        // dlopen the vendored binding from disk and wrap it with parcel's own
        // wrapper, yielding the identical public API.
        const { createRequire } = await import("node:module");
        const requireFn = createRequire(import.meta.url);
        const binding = requireFn(nodePath); // absolute path → no base-dir resolution needed
        return createWrapper(binding) as typeof import("@parcel/watcher");
      }
      return import("@parcel/watcher"); // dev / non-compiled: unchanged
    })();
    return parcelWatcherPromise;
  }
  ```
  Keep the existing `import type * as parcel from "@parcel/watcher"` (types only).
- **Export the loader from the barrel** so the second consumer can reuse it:
  `plugins/infra/plugins/file-watcher/server/index.ts` adds
  `export { loadParcelWatcher } from "./internal/create-file-watcher";`
  (rename to a public name, e.g. `getParcelWatcher`, and export
  `type AsyncSubscription`-shaped helpers as needed). Update the internal callsite
  accordingly.

Why a first-party shim rather than relying on bun resolving the bundled
`index.js`'s `require(<platform-pkg>)` against an on-disk `node_modules`: the
absolute-path dlopen is deterministic and is exactly the migrations/PG precedent
the team already trusts; it removes all ambiguity about compiled-binary module
resolution.

### 2. release CLI: vendor the platform `.node`

`plugins/framework/plugins/cli/bin/commands/release.ts`

- Add a resolver next to `embeddedNativeDir` / `pgbouncerNativeBin` (~line 320-352):
  ```ts
  /** Resolve the @parcel/watcher prebuilt native .node for the host platform. */
  function parcelWatcherNativeNode(root: string): string {
    const tag = platformTag();                 // darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64
    const pkg = process.platform === "linux"
      ? `@parcel/watcher-${tag}-glibc`         // parcel suffixes linux with -glibc/-musl; releases target glibc
      : `@parcel/watcher-${tag}`;
    // The platform package is an optionalDependency of @parcel/watcher and lives
    // in bun's store (not symlinked at top-level node_modules), so resolve it
    // FROM @parcel/watcher's own dir. Its package.json main is "watcher.node".
    const parcelDir = dirname(Bun.resolveSync("@parcel/watcher", root));
    const file = join(dirname(Bun.resolveSync(`${pkg}/package.json`, parcelDir)), "watcher.node");
    if (!existsSync(file)) {
      throw new Error(`release: parcel-watcher native not found at ${file}; run \`bun install\` first`);
    }
    return file;
  }
  ```
- In step `[3/5]` (~after the pgbouncer vendoring, line ~528), copy it in:
  ```ts
  console.log("  • parcel-watcher native addon");
  mkdirSync(join(out, "parcel-watcher"), { recursive: true });
  cpSync(parcelWatcherNativeNode(root), join(out, "parcel-watcher", "watcher.node"));
  ```
- Update the staged-layout doc comment (lines 31-48) to list
  `parcel-watcher/watcher.node   vendored @parcel/watcher native addon`.

### 3. launcher: point the env var at the vendored addon

`plugins/infra/plugins/launcher/bin/launch.ts` — alongside the other
`SINGULARITY_*` overrides (after line 46), **before** the dynamic launcher import:
```ts
// @parcel/watcher's native .node can't be embedded by `bun --compile`; point the
// file-watcher loader at the vendored addon. The gateway inherits this env and
// forwards it to the spawned backend, which is the process that starts watchers.
process.env.SINGULARITY_PARCEL_WATCHER_NODE ??= join(
  bundleRoot, "parcel-watcher", "watcher.node",
);
```

### 4. Reroute the second consumer through the chokepoint

`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts`

- Drop the static value import `import parcel from "@parcel/watcher"`; keep a
  type-only `import type * as parcel from "@parcel/watcher"` for the
  `parcel.AsyncSubscription` annotation.
- In `openRoom`, obtain the API lazily from the file-watcher barrel before
  subscribing:
  ```ts
  import { getParcelWatcher } from "@plugins/infra/plugins/file-watcher/server";
  ...
  const parcel = await getParcelWatcher();
  room.subscription = await parcel.subscribe(room.worktreePath, cb, { ignore: IGNORE });
  ```
  (Its existing debounce/ceiling/room logic is untouched — only the import path and
  the one `subscribe` acquisition change.) This makes it release-safe and removes
  the eager-native-load footgun. No `@parcel/watcher` deep `wrapper` import here.

### 5. Lint rule: forbid direct `@parcel/watcher` value-imports outside file-watcher

New rule sub-plugin, mirroring `icon-safety`:
`plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety/`
- `package.json` — `{ "name": "@singularity/plugin-framework-tooling-lint-watcher-safety", "version": "0.0.1", "private": true, "description": "watcher-safety lint rule: no-direct-parcel-watcher" }`
- `lint/index.ts` — `export default { name: "watcher-safety", rules: { "no-direct-parcel-watcher": noDirectParcelWatcher } }`
- `lint/no-direct-parcel-watcher.ts` — `ImportDeclaration` rule (copy `no-lucide-react.ts` shape) that reports when `node.source.value === "@parcel/watcher"` or starts with `"@parcel/watcher/"`, **unless**:
  - the import is type-only (`node.importKind === "type"`), or
  - `context.filename` is within `plugins/infra/plugins/file-watcher/` (the sanctioned chokepoint).
  Message: "Import `@parcel/watcher` only inside the file-watcher plugin. Use `getParcelWatcher()` / `createFileWatcher` from `@plugins/infra/plugins/file-watcher/server` so the release's vendored native addon (SINGULARITY_PARCEL_WATCHER_NODE) is honored."
- `CLAUDE.md` — one-line description (matches the `icon-safety` convention).

(Contributed lint rules are auto-discovered and applied repo-wide by the root
`eslint.config.ts`; no registry edits. The `eslint`/`type-check` checks pick it up.)

## Critical files

| File | Change |
|---|---|
| `plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts` | env-aware loader + `createWrapper` import |
| `plugins/infra/plugins/file-watcher/server/index.ts` | export `getParcelWatcher` |
| `plugins/framework/plugins/cli/bin/commands/release.ts` | `parcelWatcherNativeNode()` + vendoring step + layout comment |
| `plugins/infra/plugins/launcher/bin/launch.ts` | set `SINGULARITY_PARCEL_WATCHER_NODE` |
| `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts` | reroute through `getParcelWatcher()` |
| `plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety/**` | new lint rule (package.json, lint/index.ts, lint/no-direct-parcel-watcher.ts, CLAUDE.md) |

## Reused precedent (do not reinvent)

- **`SINGULARITY_MIGRATIONS_DIR`** — runner reads env-first (`migrations/server/internal/runner.ts:13-20`), release vendors files (`release.ts:530-538`), launcher sets env (`launch.ts:38-46`). Exact shape we follow.
- **`embeddedNativeDir` / `pgbouncerNativeBin`** (`release.ts:320-352`) — the resolver + `cpSync` vendoring shape for `parcelWatcherNativeNode`.
- **`no-lucide-react`** (`.../lint/plugins/icon-safety/lint/no-lucide-react.ts`) — the `ImportDeclaration` rule + sub-plugin shape.

## Verification

1. `./equin build` (regenerates docs/registry, runs `eslint` + `type-check` —
   confirms the new lint rule loads and the codebase still passes; the rule fires on
   any stray `@parcel/watcher` value-import).
2. Confirm the lint rule bites: temporarily add `import parcel from "@parcel/watcher"`
   to a file outside file-watcher → `./equin check eslint` should error; remove it.
3. Cut a staged release of an app composition that starts a watcher (sonata):
   ```
   bun plugins/framework/plugins/cli/bin/index.ts release --composition sonata --target web --dev --out /tmp/sonata-rel
   ```
   - Assert the addon was vendored: `ls /tmp/sonata-rel/parcel-watcher/watcher.node`.
   - Boot it: `/tmp/sonata-rel/launch` (self-roots `SINGULARITY_DIR` under `<out>/data`).
   - **PASS** = no `[plugin.infra.git-watcher] onReady failed` / `Cannot require module ./build/Release/watcher.node` in stdout, and `http://sonata.localhost:9100` serves.
   - Optional: edit a file under the worktree and confirm git-watcher reacts (watcher actually functional, not just non-crashing).
4. Sanity: `grep -rn "Cannot require module" <launch logs>` empty; the backend log
   shows the git-watcher onReady completing.

## Notes / risks

- **Internal coupling to `@parcel/watcher/wrapper.js`**: relied upon only in the
  release branch; `wrapper.js` is the same module `index.js` itself uses and has been
  stable across 2.x. The version is pinned by `bun.lock` (2.5.6). If parcel ever adds
  an `exports` map blocking the deep import, the resolver step would fail loudly at
  build, not silently — acceptable.
- **Linux musl**: `parcelWatcherNativeNode` assumes glibc (consistent with the
  embedded-PG/PgBouncer natives, which are glibc). musl hosts are out of scope, same
  as the rest of the release pipeline.
- Runtime `require()` of an absolute on-disk `.node` inside a `bun --compile` binary
  is supported (bun 1.3.13); the binary already dlopens system libs via `bun:ffi`
  (`server-core/core/phys-footprint.ts`). The addon is loaded from disk, never embedded.
</content>
</invoke>
