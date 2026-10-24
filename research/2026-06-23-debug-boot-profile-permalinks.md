# Boot-profile permalinks — persist & share a captured boot trace

## Context

`/debug/boot-profile` renders a Gantt of the **current tab's** boot, read live from
an in-memory module store (`getBootTrace()` in
`plugins/primitives/plugins/perfs/plugins/boot-trace/web/internal/store.ts`). It is
**100% ephemeral** — reload the page and the trace is gone, and there is no way to
hand a specific captured profile to an agent for investigation.

We want a **"Copy permalink" button** that, on click, persists the current trace
snapshot to the worktree DB under a unique id and copies a shareable URL
(`http://<wt>.localhost:9000/debug/boot-profile/<id>`). Opening that URL re-renders
that exact captured profile. Plus a **browsable list** of saved traces and an
**auto-cleanup** sweep so the table never grows unbounded.

Cost is a non-issue by design: a write happens only on an explicit button click
(manual, rare), and the snapshot is already a small flat JSON object.

### Why this is cheap & correct

- `getBootTrace()` returns a **fully self-contained, JSON-serializable** object —
  only numbers/strings/null, no live refs (`store.ts:104`).
- `deriveTrace(trace)` in
  `plugins/debug/plugins/boot-profile/web/components/boot-profile-gantt.tsx:56` is a
  **pure function of its `trace` argument** — zero `performance.*` / store reads. So
  a snapshot loaded from the DB re-renders byte-for-byte identically through the
  existing Gantt with no special-casing.

## Decisions

- Store snapshots in the **worktree's own DB** (matches `slow-ops`; the trace and the
  permalink are worktree-scoped — the URL keeps the worktree subdomain).
- **No label field** (per scope decision). Identify by id + createdAt + worktree.
- **Browsable list** pane (Debug → Boot Profiles) — list endpoint omits the snapshot
  blob so listing stays cheap.
- **Auto-cleanup** via a scheduled `defineJob` deleting rows older than 30 days.

## Implementation

All new code lives under `plugins/debug/plugins/boot-profile/`, which today is
**web-only** — we add `core/`, `shared/`, and `server/` runtimes to it. Build
regenerates registries + migrations.

### 1. Shared snapshot type — add a `core` barrel to the boot-trace plugin

The `BootTrace`/`BootSpan`/`NavTiming`/`BootPhase` types currently live in
`boot-trace/web/internal/store.ts` and are only exported from the **web** barrel.
Server-side persistence must not import a web barrel. Move the pure type
definitions to a new cross-runtime core barrel (the principled home for
types shared across runtimes):

- New `plugins/primitives/plugins/perfs/plugins/boot-trace/core/types.ts` — the four
  type defs (moved verbatim).
- New `core/index.ts` — `export * from "./types"` + `export default definePlugin({})`.
- `web/internal/store.ts` imports the types from `../../core/types`; `web/index.ts`
  keeps re-exporting them (same-plugin re-export is allowed) so existing web
  consumers don't churn.

### 2. Field record + table (`core` + `server`)

Mirror `slow-ops` exactly (single fields-record → table **and** wire schema, so drift
is unrepresentable — see `slow-ops/server/internal/tables.ts` and its core
`slowOpFields`).

`plugins/debug/plugins/boot-profile/core/fields.ts`:

```ts
import { uuidField } from "@plugins/fields/uuid/config";
import { textField } from "@plugins/fields/text/config";
import { jsonField } from "@plugins/fields/json/config";
import { dateField } from "@plugins/fields/date/config";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import type { BootTrace } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";

export const savedBootTraceFields = {
  id:        uuidField(),
  worktree:  textField(),
  snapshot:  jsonField<BootTrace>(),
  createdAt: dateField(),
} satisfies FieldsRecord;

export const SavedBootTraceSchema = fieldsToZodObject(savedBootTraceFields);
export type SavedBootTrace = /* z.infer<typeof SavedBootTraceSchema> */;
```

`plugins/debug/plugins/boot-profile/server/internal/tables.ts`:

```ts
const savedBootTraces = defineEntity("boot_traces", savedBootTraceFields, {
  primaryKey: "id",
  columns: {
    id:        { default: defaultRandom() },
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [index("boot_traces_created_at_idx").on(t.createdAt)], // for sweep + list ordering
});
export const _bootTraces = savedBootTraces.table; // drizzle-kit discovery
```

### 3. Endpoints (`shared/endpoints.ts`) — mirror `slow-ops/shared/endpoints.ts`

```ts
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { z } from "zod";
import { BootTraceSchema } from "../core/fields"; // explicit zod schema for the snapshot blob

// POST: persist current snapshot, return generated id
export const saveBootTrace = defineEndpoint({
  route: "POST /api/boot-traces",
  body: z.object({ snapshot: BootTraceSchema }),
  response: z.object({ id: z.string() }),
});

// GET one (with snapshot) for the detail render
export const getSavedBootTrace = defineEndpoint({
  route: "GET /api/boot-traces/:id",
  response: SavedBootTraceSchema, // { id, worktree, snapshot, createdAt }
});

// GET list (metadata only — no snapshot blob) for the browse pane
export const listBootTraces = defineEndpoint({
  route: "GET /api/boot-traces",
  response: z.object({
    items: z.array(z.object({ id: z.string(), worktree: z.string(), createdAt: z.string() })),
  }),
  dedupe: true,
});
```

> `BootTraceSchema` is an explicit zod mirror of `BootTrace` (so a malformed payload
> fails loudly). Add a compile-time assertion that `z.infer<typeof BootTraceSchema>`
> is assignable to the core `BootTrace` so the two can't silently drift.

### 4. Server handlers + cleanup job (`server/`)

`server/internal/handlers.ts` — `implement()` (db handle obtained like
`slow-ops/server/internal/record-slow-op.ts`, i.e. `@plugins/database/server`):

- `saveBootTrace`: `insert(_bootTraces).values({ worktree: process.env.SINGULARITY_WORKTREE, snapshot: body.snapshot }).returning({ id })` → `{ id }`.
- `getSavedBootTrace`: select by `params.id`; `throw new HttpError(404, ...)` if missing.
- `listBootTraces`: select `{ id, worktree, createdAt }` ordered by `createdAt desc`.

`server/internal/cleanup-job.ts` — `defineJob` from
`@plugins/infra/plugins/jobs/server` on a daily schedule (copy the schedule syntax
from an existing scheduled job, e.g. `op-rate`/`queue-health`'s monitor jobs), running
`delete(_bootTraces).where(lt(createdAt, now - 30d))`. Scheduled job, **not** an
in-process timer (per the no-polling rule).

`server/index.ts` — `definePlugin` wiring the handlers + job, mirroring how
`slow-ops` / `heap-snapshot` server barrels register their `implement()` handlers and
jobs.

### 5. Web — refactor Gantt to accept a `trace` prop, add panes & button

**Refactor** `boot-profile-gantt.tsx`: make `BootProfileGantt` a **pure presentational**
component taking `{ trace: BootTrace }`. Move the live-store plumbing (the two
`useEffect`s at lines 238/245 reading `getBootTrace()`/`subscribeBootTrace()`, the
`refreshKey` state) **out** into the live wrapper. Everything downstream
(`deriveTrace`, `BootSummary`, `ResourcesGroup`, …) already takes pure props — zero
changes there.

`panes.tsx`:

```ts
// Live pane (unchanged URL /debug/boot-profile) — wrapper owns live state + controls
export const bootProfilePane = Pane.define({
  id: "debug-boot-profile",
  segment: "boot-profile",
  component: BootProfileBody, // live: subscribe + Refresh/Reload + "Copy permalink"
});

// Detail pane — /debug/boot-profile/<id>  (static prefix required before :id)
export const bootProfileDetailPane = Pane.define({
  id: "debug-boot-profile-detail",
  segment: "boot-profile/:id",
  defaultAncestors: [bootProfilePane],
  resolve: false,
  component: BootProfileDetailBody,
});
```

- `BootProfileBody` (live): holds trace state via `subscribeBootTrace`; renders
  controls + `<BootProfileGantt trace={trace} />`. New **Copy permalink** button:

  ```ts
  const save = useEndpointMutation(saveBootTrace);
  const onCopyPermalink = async () => {
    const { id } = await save.mutateAsync({ body: { snapshot: getBootTrace() } });
    const url = `${window.location.origin}/debug/boot-profile/${id}`;
    await navigator.clipboard.writeText(url);
    toast(`Permalink copied: ${url}`); // Shell.Toast
  };
  ```
  (Async id → write clipboard directly + toast, rather than the up-front
  `useCopyToClipboard(text)` hook.)

- `BootProfileDetailBody`: `const { id } = bootProfileDetailPane.useParams();`
  → `useEndpoint(getSavedBootTrace, { id })` → loading / 404 states →
  `<BootProfileGantt trace={data.snapshot} />`, with a small banner
  ("Saved snapshot · <relative time> · <worktree>") instead of the live controls.

- `BootProfileListBody` (browse): `useEndpoint(listBootTraces, {})` → rows linking to
  the detail pane via `openPane(bootProfileDetailPane, { id })`.

`web/index.ts`: add `Pane.Register` for the detail + list panes, and a
`DebugApp.Sidebar` entry "Boot Profiles" opening the list pane.

## Files

**New** — under `plugins/debug/plugins/boot-profile/`:
- `core/fields.ts`, `core/index.ts`
- `shared/endpoints.ts`
- `server/index.ts`, `server/internal/tables.ts`, `server/internal/handlers.ts`, `server/internal/cleanup-job.ts`
- `web/components/boot-profile-detail.tsx`, `web/components/boot-profile-list.tsx`

**New** — under `plugins/primitives/plugins/perfs/plugins/boot-trace/`:
- `core/types.ts`, `core/index.ts`

**Modified**:
- `boot-trace/web/internal/store.ts` (import types from core), `boot-trace/web/index.ts` (re-export from core)
- `boot-profile/web/panes.tsx` (add detail + list panes; live wrapper owns controls)
- `boot-profile/web/components/boot-profile-gantt.tsx` (pure `trace` prop)
- `boot-profile/web/index.ts` (register new panes + sidebar entry)
- `boot-profile/CLAUDE.md` (document the new server runtime + permalink feature)

## Verification

1. `./equin build` (regenerates registries + the `boot_traces` migration; commit
   the generated migration). Confirm `./equin check` passes (boundaries,
   migrations-in-sync, plugins-registry-in-sync, plugins-doc-in-sync).
2. Open `http://<wt>.localhost:9000/debug/boot-profile`, click **Copy permalink**.
   Confirm a toast with the URL, and `mcp__singularity__query_db`:
   `select id, worktree, created_at from boot_traces;` shows one row.
3. Open the copied `…/boot-profile/<id>` URL in a fresh tab → the Gantt renders
   **identically** to the live capture, with the "Saved snapshot" banner. Use
   `e2e/screenshot.mjs` to diff before/after if desired.
4. Open Debug → **Boot Profiles**; confirm the saved trace is listed and the row opens
   the detail pane.
5. Hit a bad id `…/boot-profile/does-not-exist` → graceful 404/not-found state.
6. Cleanup job: unit-test the delete predicate (rows older than 30d) in a co-located
   `*.test.ts`, or temporarily insert a row with an old `created_at` via build and
   confirm the scheduled sweep removes it.
