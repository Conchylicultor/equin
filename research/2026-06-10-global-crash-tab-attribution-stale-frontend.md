# Crash Tab Attribution + Robust Frontend Staleness Detection

**Date:** 2026-06-10
**Category:** global (build / crashes / notifications / primitives)
**Status:** Plan — awaiting approval

## Context

A crash was filed on the **main** namespace: `CorruptModelError: corrupt/unknown stored model "fable-5"`. `fable-5` is a model that was *just added* (commit `21ad603fd`). The crash came from a browser tab still running a **pre-`fable-5` frontend bundle**: the server (new code) had pinned a conversation to `fable-5`, and the stale tab's `StoredModelSchema` (`tolerantEnum`/`normalizeModel`/`reportUnknownModel` in `plugins/conversations/plugins/model-provider/core/registry.ts`) degraded gracefully **but filed a crash task** for what is benign rollout churn.

Two needs fall out of this:

1. **Robustly detect when a tab is running an obsolete frontend** — today this is only inferred inside `BuildButton` by watching the `build.frontendHash` push resource change *during the tab's lifetime*; a tab that *loads* an already-stale `index.html` is never flagged.
2. **Attribute every crash to the tab that produced it** — crash notifications are common to all tabs, so the UI should signal "this error originated from **this tab** / **another tab** / an **outdated tab**." This is more useful than a refresh toast: every other tab learns the crash is not its problem, and the stale tab learns it needs a refresh.

### Decisions (confirmed with user)

- **Stale-origin crash policy:** *keep everything* — record the crash, **still file the task**, but route it through the existing **silent-crash (noise) system** so the notification is **muted**, and always stamp attribution. Implemented as a **named `stale-frontend` noise rule** (not a bespoke `if`) so the silence reason is first-class and discoverable. (Caveat: the deduped task is still filed; only the notification is muted. A stale-origin→no-task rule can be added later if those tasks prove noisy.)
- **Attribution surfaces:** **notification bell + Debug → Crashes pane.**
- **md5 `hash`:** keep it (additive, zero back-compat risk); `buildId` supersedes it functionally. Optional later cleanup.
- **Tab id:** `sessionStorage`-backed (stable across reloads, unique per tab) in a new tiny `primitives/tab-id` plugin.

## Architecture overview

```
build.ts ──computes buildId BEFORE vite──┐
   ├─ passes VITE_BUILD_ID=<id> into vite build  → baked into bundle (import.meta.env.VITE_BUILD_ID)
   └─ writes <id> to dist/.build-id              → read by server at boot
                                                       │
server: getServerBuildId() reads dist/.build-id ──────┤
   ├─ build.frontendHash resource now returns { hash, buildId }   (client compares baked vs server → robust stale)
   └─ record-crash: staleOrigin = report.buildId !== serverBuildId → silent (noise) rule

client report() stamps every crash with { clientId: getTabId(), buildId: VITE_BUILD_ID }
   → crashes row gains last_client_id / last_build_id (last-writer-wins, NOT in fingerprint)
   → bell + debug pane render "this tab / another tab / outdated tab"
```

**Two invariants that make it correct:**
- The baked id and the on-disk `.build-id` come from the **same variable** in `build.ts`, computed *before* vite runs — so bundle and server agree by construction (no chicken-and-egg).
- The server **restarts on every build** after the atomic `dist` swap, so a once-read `.build-id` always equals the currently-served bundle.

## Implementation

### (A) Baked build-id pipeline

**`plugins/framework/plugins/web-core/vite.config.ts`** — add a `define` block (no `define` exists today):
```ts
define: {
  "import.meta.env.VITE_BUILD_ID": JSON.stringify(process.env.VITE_BUILD_ID ?? "dev"),
},
```
The `"dev"` fallback makes staleness inert under the dev server.

**`plugins/framework/plugins/cli/bin/commands/build.ts`**:
- **Before** the parallel vite block (~line 851), compute the id once. Hoist a short-commit read (`Bun.spawnSync(["git","rev-parse","--short","HEAD"])`, tolerant of empty output) and:
  ```ts
  const buildId = `${shortCommit || "nocommit"}-${Date.now()}`;
  ```
  (`Date.now()` is fine here — CLI/Bun, not a Workflow script.)
- Add `VITE_BUILD_ID: buildId` to the vite `execBuffered` env (next to `VITE_OUT_DIR: stagingName`, ~line 855).
- After build success, next to the existing `.build-commit` write (~line 909), add (unconditionally — `buildId` is always set):
  ```ts
  writeFileSync(resolve(stagingPath, ".build-id"), buildId + "\n");
  ```
  Rides the same atomic `dist` symlink swap.

### (B) Server build-id source + resource

**New `plugins/build/server/internal/server-build-id.ts`** — read `.build-id` once at module load, memoized:
```ts
import { WEB_DIST_DIR } from "@plugins/infra/plugins/paths/server";
let cached: string | null | undefined;
export function getServerBuildId(): string | null { /* sync read `${WEB_DIST_DIR}/.build-id`, trim, cache; null on miss */ }
```
Mirrors `git-status.ts` reading `.build-commit`.

**`plugins/build/core/resources.ts`** — extend schema + descriptor default:
```ts
export const FrontendHashSchema = z.object({ hash: z.string(), buildId: z.string() });
frontendHashResource = resourceDescriptor<FrontendHash>("build.frontendHash", FrontendHashSchema, { hash: "", buildId: "" });
```

**`plugins/build/server/internal/frontend-hash-resource.ts`** — add `buildId: getServerBuildId() ?? ""` to the loader return (leave md5 `getFrontendHash()` untouched).

**`plugins/build/server/index.ts`** — `export { getServerBuildId } from "./internal/server-build-id";` (so `crashes/server` imports it from the barrel, not `internal/`).

Barrels in `build/core/index.ts` / `build/shared/index.ts` already re-export the schema/descriptor — shape change flows through automatically.

### (C) build-button refactor + reusable `useStaleFrontend()`

**New `plugins/build/web/hooks/use-stale-frontend.ts`**:
```ts
export function useStaleFrontend(): { stale: boolean; serverBuildId: string | null } {
  const res = useResource(frontendHashResource);
  const serverBuildId = res.pending ? null : (res.data.buildId || null);
  const baked = import.meta.env.VITE_BUILD_ID ?? "dev";
  const stale = !!serverBuildId && baked !== "dev" && serverBuildId !== baked;
  return { stale, serverBuildId };
}
```
Robust: compares the **executing bundle's baked id** vs the **server's current id** — fires even for a tab that *loaded* an already-stale `index.html`. The `baked !== "dev"` guard keeps it inert in dev.

**`plugins/build/web/components/build-button.tsx`** — replace the lines 19-32 `frontendHashResource` + `initialHashRef` + `useEffect` latch with `const { stale: staleTab } = useStaleFrontend();`. Repoint `loaded` to another resource's `!pending` (e.g. `aheadResult`). Status/label/reload-chip logic unchanged.

**`plugins/build/web/index.ts`** — `export { useStaleFrontend } from "./hooks/use-stale-frontend";`

### (D) tab-id primitive

**New plugin `plugins/primitives/plugins/tab-id/`** — shared by `crashes/web` (stamp) and `notifications/web` (display); a primitive is the clean shared home. Auto-discovered by codegen on `./equin build` (no manual `plugins.ts` edit).

- `package.json` — `{ "name": "@singularity/plugin-primitives-tab-id", "private": true, "version": "0.0.1", "description": "..." }`
- `web/internal/tab-id.ts`:
  ```ts
  const KEY = "singularity.tabId";
  export function getTabId(): string {
    try {
      let id = sessionStorage.getItem(KEY);
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(KEY, id); }
      return id;
    } catch { return "no-tab-id"; }
  }
  ```
- `web/index.ts`:
  ```ts
  import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
  export { getTabId } from "./internal/tab-id";
  export default { description: "...", contributions: [] } satisfies PluginDefinition;
  ```
  (Tiny primitives default-export a plain `PluginDefinition` object — see `primitives/spinner/web/index.ts` — **not** `definePlugin()`.)
- `CLAUDE.md` — short reference (convention).

### (E) Crash report stamping + schema/table/migration

**`plugins/crashes/web/report.ts`** — stamp centrally so all 5 report sites are covered at once:
```ts
import { getTabId } from "@plugins/primitives/plugins/tab-id/web";
const stamped = { ...body, clientId: getTabId(), buildId: import.meta.env.VITE_BUILD_ID ?? null };
return await fetchEndpoint(reportCrash, {}, { body: stamped, keepalive: true, report: false });
```

**`plugins/crashes/shared/types.ts`** — add `clientId?: string | null;` and `buildId?: string | null;` to `CrashReport`.

**`plugins/crashes/shared/endpoints.ts`** — add `clientId: z.string().nullable().optional()`, `buildId: z.string().nullable().optional()` to the `reportCrash` body schema (else stripped at validation).

**`plugins/crashes/server/internal/tables.ts`** — add two nullable text columns (do **not** touch fingerprint or the `(fingerprint, worktree)` unique index):
```ts
lastClientId: text("last_client_id"),
lastBuildId: text("last_build_id"),
```
`./equin build` auto-generates the `ALTER TABLE "crashes" ADD COLUMN ...` migration (precedent: noise column `20260607_170251_d0abe97f`). **Never** run drizzle-kit manually.

**`plugins/crashes/core/resources.ts`** — add `lastClientId: z.string().nullable()`, `lastBuildId: z.string().nullable()` to `CrashSchema`. Server resource is `db.select().from(_crashes)` (no column filter) so values flow automatically.

### (F) Server policy — silent via a named noise rule

**`plugins/crashes/server/internal/record-crash.ts`**:
- Import `getServerBuildId` from `@plugins/build/server`. (`crashes/server → build/server` is a new but allowed edge.)
- Compute before classification:
  ```ts
  const serverBuildId = getServerBuildId();
  const staleOrigin = input.buildId != null && serverBuildId != null && input.buildId !== serverBuildId;
  ```
- Pass `staleOrigin` into the noise classifier input (see below) so `noise` becomes `true` for stale-origin crashes → the existing `muted: row.noise` mutes the notification. **Task creation and the notification are otherwise unchanged** ("keep everything").
- **`[Stale tab]` task marker:** thread `staleOrigin` into `ensureTaskForCrash` → `taskTitle`/`taskDescription`. When true, prefix the task title with `[Stale tab] ` and add a line to the description (e.g. `**Origin:** stale frontend tab (build <lastBuildId> vs current <serverBuildId>) — likely benign version-skew, not a live bug.`). The marker reflects origin at task-creation time (the row is deduped, so the task is created once); a later up-to-date recurrence does not recreate the task.
- Insert **and** `onConflictDoUpdate.set` gain `lastClientId: input.clientId ?? null, lastBuildId: input.buildId ?? null` (last-writer-wins — a later up-to-date report overwrites `lastBuildId`).
- Add `clientId`/`buildId` to the `recordNotification` `metadata` (for the bell chip).

**Named silent rule** — extend the noise system rather than branching inline:
- `plugins/crashes/server/internal/noise-rules.ts` — extend `CrashNoiseInput` with `staleOrigin?: boolean`; `recordCrash` passes it into `isNoiseCrash(...)`.
- Add a built-in rule in `plugins/crashes/plugins/noise-rules/server/index.ts`: `{ name: "stale-frontend", matches: (i) => i.staleOrigin === true }`. This makes "silenced because it came from an outdated tab" a first-class, discoverable reason (shows as the `noise` badge in Debug → Crashes), satisfying "make the silent system more visible."

**Dedup interaction (verified safe):** a stale-origin first hit files a (muted) task and stores the old `lastBuildId`. A later up-to-date report of the same fingerprint is **not** stale → not silenced → overwrites `lastBuildId` with the current id and `ensureTaskForCrash`/notification behave normally. Count stays accurate.

**Why derive, not store `staleOrigin`:** the "outdated tab" badge is `lastBuildId !== serverBuildId`, evaluated client-side against the live server build id. A stored boolean would lie after the next build changes `serverBuildId`; a derived one self-corrects. (`noise` is still stored — that's the silence flag, which is correct to persist.)

### (G) Debug → Crashes pane

**`plugins/debug/plugins/crashes/web/components/crashes-view.tsx`**:
- Import `getTabId` from `@plugins/primitives/plugins/tab-id/web` and `useStaleFrontend` from `@plugins/build/web`.
- In `CrashesView`, `const { serverBuildId } = useStaleFrontend();` and pass to `CrashRow`.
- In `CrashRow`, after the existing badges (reuse `Badge` from `@plugins/primitives/plugins/badge/web`, `size="md"`):
  - **`this tab`** (`info`) when `c.lastClientId === getTabId()`, else **`another tab`** (`muted`) when `c.lastClientId != null`.
  - **`outdated tab`** (`warning`) when `c.lastBuildId != null && serverBuildId != null && c.lastBuildId !== serverBuildId`.

### (H) Notification bell

**`plugins/notifications/web/components/bell-button.tsx`** — keep generic (the bell must not import `crashes`):
- Import `getTabId` from `@plugins/primitives/plugins/tab-id/web`.
- In `NotificationRow`, read `const clientId = typeof n.metadata?.clientId === "string" ? n.metadata.clientId : null;`. When present, render a small inline `text-[10px] text-muted-foreground` chip in the meta row: **"this tab"** if `clientId === getTabId()`, else **"another tab"**.
- (Optional, same pattern) "outdated" needs the live server build id — keep the bell's `outdated` signal out of scope to avoid pulling the build resource into the bell; the Debug pane carries the "outdated tab" badge. The bell shows this-vs-another-tab.

`NotificationSchema.metadata` is already `z.record(z.unknown()).nullable()` and fully exposed to web — no schema change. Muted crash notifications still render (greyed) in the bell, so the chip shows on them.

## Critical files

| Area | File |
|---|---|
| Bake id | `plugins/framework/plugins/web-core/vite.config.ts`, `plugins/framework/plugins/cli/bin/commands/build.ts` |
| Server id + resource | `plugins/build/server/internal/server-build-id.ts` (new), `plugins/build/server/internal/frontend-hash-resource.ts`, `plugins/build/core/resources.ts`, `plugins/build/server/index.ts` |
| Stale signal | `plugins/build/web/hooks/use-stale-frontend.ts` (new), `plugins/build/web/components/build-button.tsx`, `plugins/build/web/index.ts` |
| Tab id | `plugins/primitives/plugins/tab-id/**` (new plugin) |
| Report stamping | `plugins/crashes/web/report.ts`, `plugins/crashes/shared/types.ts`, `plugins/crashes/shared/endpoints.ts` |
| Table/schema | `plugins/crashes/server/internal/tables.ts`, `plugins/crashes/core/resources.ts` (migration auto-generated) |
| Policy / silent rule | `plugins/crashes/server/internal/record-crash.ts`, `plugins/crashes/server/internal/noise-rules.ts`, `plugins/crashes/plugins/noise-rules/server/index.ts` |
| UI | `plugins/debug/plugins/crashes/web/components/crashes-view.tsx`, `plugins/notifications/web/components/bell-button.tsx` |

## Verification (end-to-end)

1. **Build:** `./equin build`. Confirm `web/dist/.build-id` exists; `web.generated.ts` gained a `primitives/plugins/tab-id` entry; a new `ALTER TABLE "crashes" ADD COLUMN last_client_id/last_build_id` migration appeared under `plugins/database/plugins/migrations/data/`.
2. **Two tabs, current build:** open tab A + tab B (same namespace), trigger a crash in A. In **Debug → Crashes**: tab A shows **`this tab`** (info), tab B shows **`another tab`** (muted) on the same row. Bell: A shows "this tab" chip, B shows "another tab".
3. **`query_db`:** `select fingerprint, count, task_id, noise, last_client_id, last_build_id from crashes order by last_seen_at desc limit 5;` — `last_client_id` = tab A's `sessionStorage["singularity.tabId"]`, `last_build_id` = current `.build-id`, `task_id` non-null, `noise=false`.
4. **Simulate stale tab:** keep A open, make a trivial change, `./equin build` again (new id, server restarts). Tab A's build button shows **"Server updated / Reload"** (via `useStaleFrontend`). Trigger a **new-fingerprint** crash from the still-loaded stale tab A.
   - `query_db`: row exists, `noise=true`, `last_build_id` = *old* id, **`task_id` non-null** (task still filed — "keep everything"). Bell: notification present but **muted/greyed** with **"another/outdated"** attribution; no toast, no badge bump. Debug pane: **`outdated tab`** + `noise` badges.
5. **Up-to-date re-report:** reload tab A (now current), trigger the **same fingerprint**. `query_db`: `noise=false`, `last_build_id` updated to current, `count` incremented, normal (un-muted) notification — confirms a genuine recurrence from a current tab behaves normally.

## Risks / tradeoffs

- **Task still filed for stale-origin** (per "keep everything") — the original `fable-5`-style task still appears, just silently + attributed. If noisy, add a stale-origin→no-task rule later.
- **md5 `hash` kept** — vestigial once `buildId` lands; optional cleanup.
- **Bell genericity** — keyed on `metadata.clientId` presence; the bell stays decoupled from `crashes` at the cost of an implicit convention.
- **Dev mode** — `VITE_BUILD_ID="dev"` + missing `.build-id` ⇒ staleness inert and `staleOrigin` always false. No false reload dots, no false silencing.
- **New edge `crashes/server → build/server`** — allowed by boundaries (`plugin.** -> plugin.**`); import the `getServerBuildId` barrel symbol, not `internal/`.
