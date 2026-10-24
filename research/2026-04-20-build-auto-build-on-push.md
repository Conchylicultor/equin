# Auto-Build on Push

## Context

The build plugin provides a toolbar button to manually trigger `./equin build`. When an agent pushes code to main, the worktree app is now out of date. Users must remember to manually click "Build" to pick up the new changes. This is friction — especially in a self-evolving system where agents push frequently.

This plan adds a server-side watcher that detects new pushes (via the `pushes` table maintained by the tasks push-watcher) and automatically triggers a build. The option is exposed as a boolean toggle in Settings (default: on).

---

## Implementation Plan

### 1. Shared config — `plugins/build/shared/config.ts` (new file)

```ts
import { defineConfig } from "@plugins/config/shared";

export const buildConfig = defineConfig({
  autoBuild: {
    default: true,
    label: "Auto-build on push",
    description: "Automatically run ./equin build when a new push to main is detected.",
  },
});
```

---

### 2. Extract shared build logic — `plugins/build/server/internal/run-build.ts` (new file)

Extract the core build logic out of `handle-build.ts` so both the HTTP handler and the auto-watcher can call it without duplication.

```ts
// Spawns ./equin build, streams output to the build log channel,
// calls gateway restart on success. Returns exit code.
export async function runBuild(): Promise<number> { ... }
```

Refactor `handle-build.ts` to call `runBuild()` and wrap the result in a `Response`.

---

### 3. Auto-build watcher — `plugins/build/server/internal/auto-build-watcher.ts` (new file)

Polls the `pushes` table every 2 seconds. On the first tick, records the current latest push ID as the baseline (so a server restart never re-triggers a build). On subsequent ticks, if a new push ID appears, reads the `autoBuild` config value and triggers `runBuild()` if enabled. Concurrent builds are skipped.

```ts
import { db } from "../../../../server/src/db/client";
import { pushes } from "@plugins/tasks/server/api";
import { desc } from "drizzle-orm";
import { readConfig } from "@plugins/config/server/api";
import { buildConfig } from "../../shared/config";
import { runBuild } from "./run-build";

const POLL_MS = 2000;

let initialized = false;
let lastPushId: string | null = null;
let building = false;

async function tick() {
  if (building) return;

  const [latest] = await db
    .select({ id: pushes.id })
    .from(pushes)
    .orderBy(desc(pushes.createdAt))
    .limit(1);

  const latestId = latest?.id ?? null;

  if (!initialized) {
    initialized = true;
    lastPushId = latestId;
    return;
  }

  if (latestId === lastPushId) return;
  lastPushId = latestId;

  const { autoBuild } = await readConfig(buildConfig);
  if (!autoBuild) return;

  building = true;
  runBuild().finally(() => { building = false; });
}

export function startAutoBuildWatcher() {
  setInterval(
    () => tick().catch(err => console.error("[build.auto-watcher]", err)),
    POLL_MS,
  );
}
```

---

### 4. Register in server plugin — `plugins/build/server/index.ts`

```ts
import { buildConfig } from "../shared/config";
import { startAutoBuildWatcher } from "./internal/auto-build-watcher";

const plugin: ServerPluginDefinition = {
  id: "build",
  name: "Build",
  config: buildConfig,
  httpRoutes: { ... },
  onReady: startAutoBuildWatcher,
};
```

---

### 5. Register in web plugin — `plugins/build/web/index.ts`

```ts
import { Config } from "@plugins/config/web/slots";
import { buildConfig } from "../shared/config";

contributions: [
  ShellSlots.Toolbar({ component: BuildButton, group: "actions" }),
  Config.Spec(buildConfig),
],
```

---

## Files to modify

| File | Action |
|------|--------|
| `plugins/build/shared/config.ts` | **Create** — `defineConfig({ autoBuild })` |
| `plugins/build/server/internal/run-build.ts` | **Create** — extracted build logic |
| `plugins/build/server/internal/handle-build.ts` | **Modify** — delegate to `runBuild()` |
| `plugins/build/server/internal/auto-build-watcher.ts` | **Create** — push poller |
| `plugins/build/server/index.ts` | **Modify** — add `config`, `onReady` |
| `plugins/build/web/index.ts` | **Modify** — add `Config.Spec(buildConfig)` |

No schema changes needed (no new DB tables).

---

## Key imports

- `pushes` table: `import { pushes } from "@plugins/tasks/server/api"`
- `readConfig`: `import { readConfig } from "@plugins/config/server/api"`
- `defineConfig`: `import { defineConfig } from "@plugins/config/shared"`
- `Config` slot: `import { Config } from "@plugins/config/web/slots"`

---

## Verification

1. Open Settings — confirm "Auto-build on push" boolean toggle appears under the Build section, defaulting to on.
2. With toggle on: trigger a push from another conversation; within ~3 seconds the server logs should show a build starting automatically.
3. Turn the toggle off: trigger another push; confirm no build runs.
4. Manual Build button still works independently of the toggle.
5. Server restart: confirm no spurious build fires on startup (initialized-before-triggering guard).
