# `file-watcher` — Shared File Watcher Primitive

## Context

Three server-side plugins independently implement identical `@parcel/watcher` lifecycle code: debounce + ceiling timers, reconcile interval, subscription cleanup. The copy-pasted pattern (~50 lines each) diverges in small ways that make bugs likely when maintaining one but not the others. Extracting a `createFileWatcher` primitive eliminates the duplication and gives future file-watching plugins correct behavior for free.

## The three consumers

| Plugin | Dir(s) watched | Debounce | Reconcile | Event routing |
|--------|---------------|----------|-----------|---------------|
| `git-watcher` | 2 dirs (refs/heads, commonDir) | 100ms/1s global | 30s → `recompute()` | ignores events, re-reads all refs |
| `config-watcher` | 1 dir (CONFIG_DIR) | 100ms/1s per-path | 30s → fire all paths | filters `.jsonc`, routes to registered path callbacks |
| `transcript-watcher` | 1 dir (CLAUDE_PROJECTS_DIR) | none (mtime dedup) | 30s → sweep all rooms | filters `.jsonl`, routes via reverse index |

A fourth watcher (`watch-edited-files.ts`) uses per-room parcel subscriptions with different constants — out of scope.

## API design

```ts
interface FileWatcherOptions {
  dirs: string[];
  onChange: (events: parcel.Event[]) => void;
  onReconcile?: () => void;       // if omitted, reconcile calls onChange([])
  debounceMs?: number;             // default 100; 0 = immediate pass-through
  ceilingMs?: number;              // default 1000; only when debounceMs > 0
  reconcileMs?: number | null;     // default 30_000; null = disabled
  extensions?: string[];           // filter by extname (e.g. [".jsonc"])
  ignore?: string[];               // parcel ignore globs
}

interface FileWatcher {
  stop(): Promise<void>;
}

function createFileWatcher(opts: FileWatcherOptions): Promise<FileWatcher>;
```

The debounce+ceiling algorithm is identical to the existing one: adaptive delay that shortens as the ceiling approaches, with a hard ceiling timer as backstop.

## New plugin

```
plugins/infra/plugins/file-watcher/
  package.json
  server/
    index.ts                              # barrel + minimal plugin def
    internal/
      create-file-watcher.ts              # implementation
```

Server-only, no lifecycle hooks, no DB tables. Pure library — the plugin def exists only for registry inclusion and barrel imports.

## Migration

### git-watcher (`plugins/infra/plugins/git-watcher/server/internal/watcher.ts`)

**Remove:** `debounceTimer`, `ceilingTimer`, `lastRecomputeAt`, `reconcileTimer`, `scheduleRecompute()`, manual `parcel.subscribe` calls, parcel import. Also remove dead lines in `recompute()`: `lastRecomputeAt = Date.now()` and the `ceilingTimer` clear block (lines 116-120).

**Add:**
```ts
watcher = await createFileWatcher({
  dirs: [`${commonDir}/refs/heads`, commonDir],
  onChange: () => { void recompute(); },
  onReconcile: () => { void recompute(); },
});
```

**Replace** `stopGitWatcher` cleanup with `await watcher.stop()`.

### config-watcher (`plugins/config_v2/server/internal/config-watcher.ts`)

**Remove:** `debounceTimers` Map, `ceilingTimers` Map, `lastNotify` Map, `reconcileTimer`, `scheduleNotify()`, timer logic in `fireNotify()`, manual `parcel.subscribe`, parcel import.

**Simplify** `fireNotify` → `notifyWatchers` (just the callback fan-out, no timer management).

**Add:**
```ts
watcher = await createFileWatcher({
  dirs: [CONFIG_DIR],
  onChange: (events) => {
    const paths = new Set(events.map((e) => e.path));
    for (const p of paths) if (watchers.has(p)) notifyWatchers(p);
  },
  onReconcile: () => {
    for (const abs of watchers.keys()) notifyWatchers(abs);
  },
  extensions: [".jsonc"],
});
```

**Note:** Per-path debounce becomes shared debounce. Acceptable — config writes are human-paced and the 1s ceiling guarantees timely delivery.

### transcript-watcher (`plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts`)

**Remove:** `reconcileTimer`, `subscription`, manual `parcel.subscribe`, parcel import.

**Add:**
```ts
watcher = await createFileWatcher({
  dirs: [CLAUDE_PROJECTS_DIR],
  onChange: (events) => {
    for (const ev of events) {
      const convId = pathToConvId.get(ev.path);
      if (!convId) continue;
      const room = rooms.get(convId);
      if (room) void processRoom(room);
    }
  },
  onReconcile: () => {
    for (const room of rooms.values()) {
      if (room.transcriptPath) void processRoom(room);
    }
  },
  extensions: [".jsonl"],
  debounceMs: 0,
});
```

## Verification

1. `./equin build` succeeds
2. `./equin check` passes (boundaries, lint, TypeScript)
3. Config: edit a `.jsonc` in `~/.singularity/config/` → settings pane updates within ~200ms
4. Git: push to main → `git.refAdvanced` fires (debug > queue pane)
5. Transcript: send a message → JSONL viewer updates in real-time

## Files

**Create:**
- `plugins/infra/plugins/file-watcher/package.json`
- `plugins/infra/plugins/file-watcher/server/index.ts`
- `plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`

**Modify:**
- `plugins/infra/plugins/git-watcher/server/internal/watcher.ts`
- `plugins/config_v2/server/internal/config-watcher.ts`
- `plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts`
