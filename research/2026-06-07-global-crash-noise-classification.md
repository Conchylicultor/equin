# Crash noise classification — quiet "muted" crashes + Debug Crashes pane

## Context

Some crashes are structurally benign and high-frequency — the canonical example is the
`ResizeObserver loop completed with undelivered notifications` browser warning. Today every
crash does three noisy things in `recordCrash` (`plugins/crashes/server/internal/record-crash.ts`):

1. Files a task under the "Crashes" meta-task folder.
2. Fires an `error`-variant notification that **increments the bell unread badge** and lands in
   the red "Unread" section.
3. Bumps a dedup count.

Benign crashes thus spam the bell badge and the Crashes task folder. We want a way to mark
non-important crash patterns as **less noisy without hiding them** — they stay recorded,
queryable, and visible, but they stop demanding attention.

**Locked decisions (from the user):**

- **Classify via built-in patterns in code only** — no user config. ResizeObserver is the seed.
- **Suppression = keep the task, quiet the notification.** Keep `variant: "error"` but make it a
  **muted red** (dimmed/desaturated destructive), **not** the `info` variant, and it must **not**
  increment the bell badge.
- **Visibility = a new "Crashes" pane in the Debug app** listing every crash (incl. noisy ones).

**Intended outcome:** ResizeObserver-class crashes are recorded and visible in the new pane and in
the bell's "Earlier" section (muted red), still create their task, but never bump the badge or pop a
toast. Real crashes are unchanged.

---

## Design overview

Three independent pieces, plus a generic notification primitive:

1. **Noise classification** — a `CrashNoiseRule` server-contribution slot owned by the crashes
   plugin. Built-in rules are contributed by a `noise-rules` sub-plugin. `recordCrash` enumerates
   the rules and stamps a `noise` boolean on the crash row.
2. **Generic muted notifications** — add a `muted` flag to the notifications primitive. A muted
   notification keeps its variant color but is dimmed and excluded from the badge. (Not
   crash-specific — reusable for any future quiet notification.)
3. **Debug Crashes pane** — a web-only sub-plugin under `plugins/debug/` consuming a new
   web-safe `crashesResource` core descriptor.

### Why a contribution slot (not a hardcoded array)

The crashes plugin owns a generic `CrashNoiseRule` slot; contributors provide rules. This is the
"primitive that makes the next case trivial": adding a noisy pattern = one `CrashNoiseRule({...})`
contribution, no edits to the crashes core or to `recordCrash`. Per repo collection-consumer
separation, `recordCrash` only ever calls the generic `.getContributions()` — it never names a
specific rule. We keep **one** `noise-rules` sub-plugin holding an array of built-in rules (not one
sub-plugin per rule) to avoid a directory explosion while preserving slot-level extensibility.

---

## Implementation (ordered, file-by-file)

### Part 1 — Noise classification primitive

**New `plugins/crashes/server/internal/noise-rules.ts`** — define the slot + classifier:

```ts
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

export interface CrashNoiseInput {
  source: string;
  errorType: string | null;
  message: string;
  stack: string | null;
}
export interface CrashNoiseRuleSpec {
  id: string;
  matches: (input: CrashNoiseInput) => boolean;
}

export const CrashNoiseRule = defineServerContribution<CrashNoiseRuleSpec>(
  "crash-noise-rule",
  { docLabel: (r) => r.id },
);

// collectContributions() runs at boot, before any handler — getContributions() is populated
// by the time recordCrash runs (HTTP handler, onReady flush, or error reporter).
export function isNoiseCrash(input: CrashNoiseInput): boolean {
  return CrashNoiseRule.getContributions().some((rule) => {
    try {
      return rule.matches(input);
    } catch {
      return false; // a buggy rule must never break the crash pipeline (itself the error path)
    }
  });
}
```

**Modify `plugins/crashes/server/index.ts`** — re-export the factory so sub-plugins can contribute
(barrel re-exports of own internal files are allowed):

```ts
export { CrashNoiseRule } from "./internal/noise-rules";
export type { CrashNoiseRuleSpec, CrashNoiseInput } from "./internal/noise-rules";
```

**New sub-plugin `plugins/crashes/plugins/noise-rules/`** (mirrors how `endpoint-errors` imports the
parent's barrel):

- `package.json`: `{ "name": "@singularity/plugin-crashes-noise-rules", "private": true, "version": "0.0.1" }`
- `server/index.ts`:
  ```ts
  import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
  import { CrashNoiseRule } from "@plugins/crashes/server";

  const RESIZE_OBSERVER = "resizeobserver";

  export default {
    name: "Crashes: noise rules",
    description: "Built-in noise classification rules for low-signal crashes (e.g. ResizeObserver loop warnings).",
    contributions: [
      CrashNoiseRule({
        id: "resize-observer",
        matches: ({ message, errorType }) =>
          message.toLowerCase().includes(RESIZE_OBSERVER) ||
          (errorType?.toLowerCase().includes(RESIZE_OBSERVER) ?? false),
      }),
    ],
  } satisfies ServerPluginDefinition;
  ```
- `CLAUDE.md`: prose only (purpose + how to add a rule). Build inserts the autogen reference block.

### Part 2 — `noise` column on `_crashes`

**Modify `plugins/crashes/server/internal/tables.ts`** — add after `crashLoop` (`boolean` already imported):

```ts
noise: boolean("noise").notNull().default(false),
```

No new index (the pane reads all rows). Migration is generated by `./equin build` — never run
drizzle-kit manually.

### Part 3 — crashes `core/` barrel (web-safe resource)

Web panes cannot import server barrels, so the live-state handle must be a **core** descriptor
(mirror `plugins/infra/plugins/claude-cli/core/resources.ts`).

**New `plugins/crashes/core/resources.ts`** — hand-written browser-safe zod covering all columns
incl. `noise`:

```ts
import { z } from "zod";
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/core";

export const CrashSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  worktree: z.string(),
  source: z.string(),
  errorType: z.string().nullable(),
  message: z.string(),
  stack: z.string().nullable(),
  componentStack: z.string().nullable(),
  url: z.string().nullable(),
  userAgent: z.string().nullable(),
  slot: z.string().nullable(),
  label: z.string().nullable(),
  count: z.number().int(),
  crashLoop: z.boolean(),
  noise: z.boolean(),
  taskId: z.string().nullable(),
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Crash = z.infer<typeof CrashSchema>;

export const crashesResource = resourceDescriptor<Crash[]>(
  "crashes",
  z.array(CrashSchema),
  [],
);
```

**New `plugins/crashes/core/index.ts`:**

```ts
export { crashesResource, CrashSchema } from "./resources";
export type { Crash } from "./resources";
```

**Single source of truth (DRY):** switch the server resource to import the core schema (a plugin may
import its own `core/` from `server/` — claude-cli does exactly this). In
`plugins/crashes/server/internal/resources.ts`, import `CrashSchema` from `../../core/resources`
instead of `./schema`. The loader (`db.select().from(_crashes)`) structurally matches `Crash[]`.
Keep `server/internal/schema.ts` only if other code imports it; otherwise it becomes redundant.
The server `defineResource` and the core descriptor share the key `"crashes"`, so live-state wires
the web pane automatically.

### Part 4 — wire `recordCrash`

**Modify `plugins/crashes/server/internal/record-crash.ts`:**

1. `import { isNoiseCrash } from "./noise-rules";`
2. Compute before the upsert:
   ```ts
   const noise = isNoiseCrash({
     source: input.source,
     errorType: input.errorType ?? null,
     message: input.message,
     stack: input.stack ?? null,
   });
   ```
3. Add `noise,` to `.values({...})` and `noise,` to `onConflictDoUpdate.set` (so a recurrence stays
   truthfully classified if rules change later).
4. **Task creation unchanged** — `ensureTaskForCrash` still runs for noise crashes.
5. Pass the flag to the notification (keep `variant: "error"`):
   ```ts
   void recordNotification({
     type: "crash",
     title: "Crash recorded",
     description: ...,
     variant: "error",
     muted: row.noise,   // read the persisted value from the returned row
     linkTo: ...,
     metadata: { ... },
   });
   ```
6. The crash-loop early-return path (returns before the notification) is untouched.

### Part 5 — generic `muted` notifications

**`plugins/notifications/server/internal/tables.ts`** — add (`boolean` already imported):
```ts
muted: boolean("muted").notNull().default(false),
```

**`plugins/notifications/shared/schema.ts`** — add `muted: z.boolean(),` to `NotificationSchema`
(propagates to `notificationsResource` automatically).

**`plugins/notifications/server/internal/record-notification.ts`** — add `muted?: boolean;` to
`RecordNotificationInput`; set `muted: input.muted ?? false` in `.values({...})`. (The `dedupKey`
`onConflictDoNothing` path won't update `muted`; harmless — crash notifications pass no `dedupeKey`.)

**`plugins/notifications/web/components/bell-button.tsx`:**

- `unreadCount` and `isCountedUnread` — add `!n.muted`:
  ```ts
  const isCountedUnread = (n: Notification) =>
    !n.read && !n.muted && (n.variant === "error" || n.variant === "warning");
  ```
  This routes muted crashes into the "Earlier" section (visible, never badge-bumping).
- Add muted variant maps (static literals — required for Tailwind JIT) and select them when
  `n.muted`, plus force the dimmed opacity:
  ```tsx
  const VARIANT_BORDER_MUTED: Record<Notification["variant"], string> = {
    error: "border-l-destructive/40", warning: "border-l-warning/40",
    info: "border-l-info/40", success: "border-l-success/40",
  };
  const VARIANT_TEXT_MUTED: Record<Notification["variant"], string> = {
    error: "text-destructive/70", warning: "text-warning/70",
    info: "text-info/70", success: "text-success/70",
  };
  ```
  In `NotificationRow`, pick `n.muted ? *_MUTED[n.variant] : *[n.variant]` for border + title text,
  and apply `opacity-60` when `n.muted` (combining with the existing read-opacity). For an
  `error`+`muted` crash this yields the requested **muted red**, distinct from `info`.
- **Toast suppression:** in the new-notification toast effect, add `&& !n.muted` to the fire
  condition so muted crashes don't pop a transient toast. (Consistent with "less noisy"; the row
  still appears in the bell list, so it is not hidden.)
- `hasErrors` / "Errors" filter chip still treats a muted error as an error — fine, it stays
  discoverable under that chip.

### Part 6 — Debug "Crashes" pane

New web-only sub-plugin `plugins/debug/plugins/crashes/` (mirror `plugins/debug/plugins/claude-cli-calls/`).

- `package.json`: `{ "name": "@singularity/plugin-debug-crashes", "private": true, "version": "0.0.1" }`
- `web/index.ts`:
  ```ts
  import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
  import { Pane, openPane } from "@plugins/primitives/plugins/pane/web";
  import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
  import { sidebarNavItem } from "@plugins/primitives/plugins/app-shell/web";
  import { MdBugReport } from "react-icons/md";
  import { crashesPane } from "./panes";

  export { crashesPane } from "./panes";

  export default {
    name: "Crashes",
    description: "Debug pane listing all recorded crashes (including low-signal/noise ones) with source, count, noise flag, and linked task.",
    contributions: [
      Pane.Register({ pane: crashesPane }),
      DebugApp.Sidebar({
        id: "crashes",
        ...sidebarNavItem({ title: "Crashes", icon: MdBugReport, onClick: () => openPane(crashesPane, {}, { mode: "root" }) }),
      }),
    ],
  } satisfies PluginDefinition;
  ```
- `web/panes.tsx`: `crashesPane = Pane.define({ id: "crashes", segment: "crashes", component })`
  wrapped in `<PaneChrome pane={crashesPane} title="Crashes">`.
- `web/components/crashes-view.tsx`: `useResource(crashesResource)` from `@plugins/crashes/core`;
  render each row with source, `noise` badge, `loop` badge, `×count`, `<RelativeTime date={lastSeenAt} />`,
  and a `task →` link to `/tasks/t/<taskId>`. Lists **all** rows (noise shown via badge, not hidden).
  Confirm exact `Badge` variant names against `@plugins/primitives/plugins/badge/web`.
- `CLAUDE.md`: prose only.

### Part 7 — Docs / checks

`./equin build` regenerates `web.generated.ts` + server registry from the filesystem
(new `index.ts` barrels auto-discovered — no manual registry edits), generates migrations from
`tables.ts`, regenerates each plugin's `## Plugin reference` autogen block, and runs checks
(`plugins-doc-in-sync`, `plugin-boundaries`, `migrations-in-sync`, `eslint`). Two new plugins need a
hand-written **prose-only** `CLAUDE.md` (`crashes/plugins/noise-rules`, `debug/plugins/crashes`);
do not hand-write the autogen block. The crashes parent CLAUDE.md sub-plugin/export lists regenerate
automatically.

---

## Critical files

- `plugins/crashes/server/internal/record-crash.ts` (modify — classify + muted notification)
- `plugins/crashes/server/internal/tables.ts` (modify — `noise` column)
- `plugins/crashes/server/internal/resources.ts` (modify — import core schema)
- `plugins/crashes/server/index.ts` (modify — re-export `CrashNoiseRule`)
- `plugins/crashes/server/internal/noise-rules.ts` (new — slot + classifier)
- `plugins/crashes/core/{resources.ts,index.ts}` (new — web-safe descriptor)
- `plugins/crashes/plugins/noise-rules/{package.json,server/index.ts,CLAUDE.md}` (new — ResizeObserver rule)
- `plugins/notifications/server/internal/tables.ts` (modify — `muted` column)
- `plugins/notifications/shared/schema.ts` (modify — `muted` field)
- `plugins/notifications/server/internal/record-notification.ts` (modify — `muted` input)
- `plugins/notifications/web/components/bell-button.tsx` (modify — badge exclusion + muted-red render + toast guard)
- `plugins/debug/plugins/crashes/**` (new — Debug pane)

---

## Verification

1. **Build:** `./equin build` (first build auto-generates the migration for the two new
   columns). Confirms codegen + checks pass; deploys to `http://<worktree>.localhost:9000`.
2. **Schema:** `query_db` MCP → `SELECT noise FROM crashes LIMIT 1;` and
   `SELECT muted FROM notifications LIMIT 1;` confirm the columns exist.
3. **Trigger a ResizeObserver crash** through the real client path (so `recordCrash` classifies it),
   plus a normal crash (e.g. a thrown `TypeError`) as the control.
4. **DB assertions (`query_db`):**
   - `SELECT noise, task_id FROM crashes WHERE message ILIKE '%resizeobserver%';` → `noise=true`,
     `task_id` non-null (task still filed).
   - `SELECT variant, muted FROM notifications WHERE type='crash' ORDER BY created_at DESC LIMIT 1;`
     → `variant='error'`, `muted=true`.
5. **UI (`e2e/screenshot.mjs`):**
   - Bell badge does **not** increment for the ResizeObserver crash; its row shows under "Earlier"
     in dimmed red (not `info`, not in the red "Unread" header); no toast popped.
   - The control `TypeError` crash **does** increment the badge and renders full destructive red in
     "Unread".
   - Debug → Crashes pane lists the ResizeObserver row with a `noise` badge + `task →` link, and the
     control row without a noise badge.
6. `read_logs` MCP confirms `recordCrash` ran and no rule threw.
