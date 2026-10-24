# Single-source the crash-report field path

## Context

Adding a field to the crash-report pipeline currently means editing the same
field list in four independent places, none of which is forced to stay in sync:

1. `plugins/crashes/shared/types.ts` — the `CrashReport` interface
2. `plugins/crashes/shared/endpoints.ts` — the `CrashReportBodySchema` zod schema
3. `plugins/crashes/server/internal/handle-report.ts` — a field-by-field
   `body → recordCrash` hand-map
4. `plugins/crashes/server/internal/record-crash.ts` — the DB insert / upsert

This already caused a real defect: the crash-tab-attribution fields
`clientId` / `buildId` were added to the type **and** the schema **and** the DB
insert, validated and typechecked fine, but landed as `NULL` because the
`handle-report.ts` hand-map (site 3) didn't forward them. It was caught only by
manual DB inspection.

This is one instance of a broader class: **the field list is hand-maintained in
parallel at every boundary, and each hand-map can silently drop a field.** The
fix targets the class, not the instance — per the project rule "fix the
structural issue, not the specific instance."

## Diagnosis of each boundary

| Boundary | Nature | Fix |
|---|---|---|
| 1. type vs schema | Pure duplication | Derive the type from the schema → one list |
| 2. body → recordCrash | Pure redundancy (identical shape, `?? null`) | Delete the hand-map; pass `body` straight through |
| 3. recordCrash → DB row | **Real transform** (renames, clamps, computed cols) | Spread verbatim fields; list only the genuinely-different columns |

Boundary 2 is the one that bit us, and it is *pure redundancy*: `handle-report`
re-states each field with `?? null` even though `recordCrash` already coalesces
internally. That redundancy is exactly why a field can be dropped — and exactly
why it is safe to delete.

Boundary 3 cannot be a pure pass-through: `message`/`stack`/`componentStack` are
clamped, `clientId`/`buildId` rename to `lastClientId`/`lastBuildId` (deliberate
— they are last-writer-wins aggregates, *not* part of the dedup key, see
`tables.ts:32-35`), and `fingerprint`/`worktree`/`count`/`noise`/`crashLoop` are
computed. TypeScript cannot force "every input field must be read", so a fully
compile-safe insert is impossible. But the **verbatim** fields (`source`,
`errorType`, `url`, `userAgent`, `slot`, `label`) map 1:1 to columns of the same
name and can flow in via a spread — converting "add a plain field → silently
dropped" into "add a plain field → persists automatically (or a compile error if
no column exists)".

## Plan

### 1. Single-source the field list + sources (`shared/types.ts`)

Make `types.ts` the one home for the crash-report data model: source arrays,
`CrashSource`, the zod schema, and the derived TS types.

```ts
import { z } from "zod";

// Crash origins, split by who may report them. CrashSource is derived from the
// arrays so the union and the runtime allow-lists can never drift.
export const SERVER_CRASH_SOURCES = [
  "server-uncaught", "server-unhandled", "server-caught",
] as const;
export const CLIENT_CRASH_SOURCES = [
  "browser-error", "browser-rejection", "react-boundary", "client-endpoint",
] as const;
export type CrashSource =
  | (typeof SERVER_CRASH_SOURCES)[number]
  | (typeof CLIENT_CRASH_SOURCES)[number];

// THE canonical crash-report field list. The HTTP body the browser POSTs; the
// server fills in worktree + count + timestamps. `source` is restricted to
// client-reportable origins (server-* sources only arise from in-process
// recordCrash callers, never over HTTP).
export const CrashReportBodySchema = z.object({
  source: z.enum(CLIENT_CRASH_SOURCES),
  errorType: z.string().nullable().optional(),
  message: z.string(),
  stack: z.string().nullable().optional(),
  componentStack: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  slot: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  buildId: z.string().nullable().optional(),
});
export type CrashReportBody = z.infer<typeof CrashReportBodySchema>;

// recordCrash input: the same field list as the HTTP body (single-sourced from
// the schema), but `source` widened to every origin since server hooks report
// server-* sources the HTTP endpoint rejects.
export type CrashReport =
  Omit<CrashReportBody, "source"> & { source: CrashSource };
```

The old hand-written `CrashReport` interface is deleted — it is now derived.

### 2. Endpoint contract imports the shared schema (`shared/endpoints.ts`)

`endpoints.ts` keeps only the HTTP contract (route + result schema) and imports
`CrashReportBodySchema` from `types.ts` (one-directional import, no cycle).
`CrashReportResult` / `reportCrash` stay here unchanged.

```ts
import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { CrashReportBodySchema } from "./types";

export const CrashReportResultSchema = z.object({ /* unchanged */ });
export type CrashReportResult = z.infer<typeof CrashReportResultSchema>;

export const reportCrash = defineEndpoint({
  route: "POST /api/crashes",
  body: CrashReportBodySchema,
  response: CrashReportResultSchema,
});
```

### 3. Pass the validated body straight through (`server/internal/handle-report.ts`)

Delete the `VALID_SOURCES` set and the field-by-field map. The zod
`z.enum(CLIENT_CRASH_SOURCES)` now rejects bad sources at the validation layer —
the JSON codec throws `HttpError(400)` on mismatch
(`endpoints/core/codec.ts:49-55`), which is what the manual check did. The
validated `body` (`CrashReportBody`) is structurally assignable to
`recordCrash`'s `CrashReport` input (client sources ⊂ `CrashSource`; identical
field list), so it flows through with **no per-field mapping**:

```ts
import { recordCrash } from "./record-crash";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { reportCrash } from "../../shared/endpoints";

// `body` is the validated CrashReportBody — field list single-sourced from
// CrashReportBodySchema and structurally a CrashReport, so every reported field
// flows through with no hand-map (which previously silently dropped new fields).
export const handleReport = implement(reportCrash, async ({ body }) =>
  recordCrash(body),
);
```

### 4. Spread verbatim fields into the insert (`server/internal/record-crash.ts`)

Destructure the transformed/renamed fields out and spread the rest, so the
insert lists *only* the columns that genuinely differ from the report shape. A
new plain pass-through field then persists automatically; a field with no
matching column becomes a compile error (drizzle excess-property check) rather
than a silent drop.

```ts
const { message: rawMessage, stack: rawStack, componentStack: rawComponentStack,
        clientId, buildId, ...verbatim } = input;
// verbatim = { source, errorType?, url?, userAgent?, slot?, label? } — 1:1 columns

const message = clamp(rawMessage, MESSAGE_MAX);
const stack = rawStack != null ? clamp(rawStack, STACK_MAX) : null;
const componentStack =
  rawComponentStack != null ? clamp(rawComponentStack, COMPONENT_STACK_MAX) : null;

await db.insert(_crashes).values({
  id, fingerprint: fp, worktree,        // computed
  ...verbatim,                          // source, errorType, url, userAgent, slot, label
  message, stack, componentStack,       // clamped
  crashLoop: loop, noise,               // computed
  lastClientId: clientId ?? null,       // renamed (last-writer-wins aggregate)
  lastBuildId: buildId ?? null,
}).onConflictDoUpdate({ /* set block unchanged — first occurrence's text kept */ });
```

The existing `noise`/`staleOrigin`/`fingerprint` computation above the insert is
unchanged; only the `.values({...})` literal is restructured. The
`onConflictDoUpdate` `set` block (count++, lastSeenAt, lastClientId, lastBuildId,
crashLoop, noise) stays explicit — it deliberately does *not* refresh the
descriptive text columns.

### 5. Tighten the web reporter (`web/report.ts`) — optional, aligned

`report()` builds the POST body and stamps `clientId`/`buildId` itself, so its
input should be the client-reportable shape minus the auto-stamped fields. This
makes a server source at a call site a compile error instead of a runtime 400:

```ts
import type { CrashReportBody } from "../shared/types";
// Caller-supplied portion: the browser picks source + descriptive fields;
// report() stamps clientId/buildId.
export type ClientCrashReport = Omit<CrashReportBody, "clientId" | "buildId">;
export async function report(body: ClientCrashReport): Promise<CrashReportResult | null> { … }
```

All three current callers already pass client sources only
(`crash-reporter.tsx`, `endpoint-error-reporter.tsx` `client-endpoint as const`,
`corruption-reporter.tsx` `browser-error`), so no call-site changes needed.

## Files touched

- `plugins/crashes/shared/types.ts` — source arrays + schema + derived types (single source)
- `plugins/crashes/shared/endpoints.ts` — import schema from `types.ts`
- `plugins/crashes/server/internal/handle-report.ts` — drop hand-map + `VALID_SOURCES`; pass `body` through
- `plugins/crashes/server/internal/record-crash.ts` — spread verbatim fields in insert
- `plugins/crashes/web/report.ts` — tighten input type (optional)

No change needed: `buffer.ts` (`BufferedCrash extends CrashReport` still holds),
`process-hooks.ts` / `server/index.ts` (server-source `recordCrash` callers —
`source: CrashSource` still allows server-*), the three external
`conversations` callers (all `server-caught`).

## Non-goals

- Renaming `lastClientId`/`lastBuildId` columns — they are correctly named
  last-writer-wins aggregates, not part of the dedup key. They stay explicit in
  the insert by design.
- A fully compile-safe insert — impossible (TS can't force input-field
  consumption). The spread makes the common case safe + loud, which is the
  achievable structural win.

## Verification

1. `./equin build` — must pass type-check (`migrations-in-sync` should be a
   no-op: no schema change) and the `eslint` + `plugin-boundaries` checks.
2. Confirm no migration was generated (the table is untouched).
3. Trigger a client crash end-to-end and confirm `clientId` / `buildId` persist
   (the original defect):
   - Drive the app with Playwright to a page, force a `react-boundary` or
     `browser-error` crash (e.g. via an injected throw), then query the DB:
     ```
     query_db: SELECT source, last_client_id, last_build_id FROM crashes
               ORDER BY last_seen_at DESC LIMIT 3;
     ```
   - `last_client_id` / `last_build_id` must be non-NULL for the new row.
4. Negative path: POST an invalid `source` to `/api/crashes` and confirm a clean
   `400` (zod validation) rather than a 500 or a recorded crash row.
5. Server-source path unaffected: confirm a `server-caught` crash (e.g. force a
   `conversations.poller` error path, or rely on an existing one) still records
   with `last_client_id`/`last_build_id` NULL and no type error.
