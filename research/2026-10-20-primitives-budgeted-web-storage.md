# Budgeted web storage primitive

Track: "Draft and local storage" (page `block-9a32de2c-…`). Step: storage primitive.

## Context

Every plugin writes to the origin's one `localStorage` (~10 MB in Chrome, cannot be raised). Nobody owns the keys, no owner has a size cap, and nobody can see usage. On 2026-10-19 the theme cache filled the quota, and from then on every draft and pane-layout write failed. Most direct callers drop a refused write without a trace:

- `pane-restore` returns on `QuotaExceededError`.
- `miller` column widths use an empty `catch {}`.
- `data-view` swallows `DOMException`.

Unsent drafts deliberately stay in localStorage through `persistent-draft`. They are safe only if no other owner can fill the quota.

**Exit for this step:**

- All storage goes through one primitive. Each owner declares a key prefix, a size cap and a TTL.
- A write over an owner's cap, or refused by the browser, is always loud.
- A health-report row shows storage use per owner.
- A lint rule bans raw storage calls.

## Inventory (from exploration)

**Direct callers (~16 production sites).** Areas: L = localStorage, S = sessionStorage.

| Call site | Area | Notes |
|---|---|---|
| `conversations/pane-restore` | L | Per conversation, 30 d own envelope; quota silent |
| `layouts/miller` widths | L | Per tab×pane, **never cleaned**; `catch {}` |
| `layouts/miller` collapse | S | |
| `primitives/data-view` `use-view-ephemeral` | L state, S query | Unbounded `expanded` map, unguarded `JSON.parse` |
| `primitives/view-switcher` | L | |
| `apps-core/tabs` `tabs-store` | S | **Unguarded `setItem`**, read at boot |
| `apps-core/app-usage` `last-app` | S | Unguarded |
| `apps/desktop/windows` | S | |
| `scope/tab-id` | S | Boot |
| `scope/app-instance` | S | Registry plus a sweep over other owners' `*:<tabId>:*` keys |
| `live-state` `verboseTrace` | L | Debug flag |
| `theme-engine` | L | `removeItem` of the retired key |
| `pending-turn/legacy-cleanup` | L | |

**`persistent-draft` callers (~25 keys).** All share one prefix `singularity:draft:`. These grow per entity:

- `conversation:prompt` (per conversation)
- `ask-user-question:*`
- `running-agents:view`
- transcript scroll (`auto-scroll`, 1.08 MB measured)
- `map.camera:*` (TTL ∞)

Expiry happens only on read. Nothing sweeps.

**Third party.** `frimousse` (emoji picker) writes `frimousse/data/<locale>` (0.53 MB) itself, with a bare `catch{}`. Its only escape hatch is the `resolveEmojiData` prop, which replaces the cached resolver.

## Design

### 1. Primitive: `primitives/dom/plugins/web-storage` (new, web + core)

It goes under `dom`, the umbrella that is already "the one place allowed to touch the real DOM/browser APIs". It is synchronous, because boot-time readers (tab-id, tabs-store) need a sync read.

```ts
export const promptDrafts = defineStore<string>({
  owner: "conversations.prompt-draft",   // unique; doubles as the key prefix `s:<owner>:`
  label: "Prompt drafts",                // used by the toast and the health row
  area: "local" | "session",
  cap: 512 * KB,                         // bytes (UTF-16 chars × 2 of key+envelope)
  ttl: 7 * DAY | "tab",                  // "tab" only for area: "session"
  whenFull: "refuse" | "evict-oldest",
  schema: z.string(),                    // ZodParser; a read that fails it is a typed `corrupt` result, not null
  legacyKeys?: (key: string) => boolean, // pre-primitive keys this owner deletes once (migration)
});
promptDrafts.read(id) → { kind: "value", v } | { kind: "none" } | { kind: "corrupt" } | { kind: "unavailable" }
promptDrafts.write(id, v) → void        // never throws for DOMException; failures are loud (§3)
promptDrafts.remove(id); promptDrafts.entries(); promptDrafts.usage()
```

**Registry.** `defineStore` is a module-level registry, following the `defineIdKind` / `defineFileSink` precedent:

- A duplicate owner throws.
- A prefix that overlaps another owner's throws.
- A non-literal declaration is rejected by the check in §5.

**One envelope `{v, ts}` and one key grammar `s:<owner>:<id>`.** No owner hand-rolls its own.

**Usage accounting.**

- On an owner's first touch, its keys are scanned once.
- After that, usage is kept up to date incrementally from its own writes and from `storage` events, which cover other tabs.
- That gives O(1) cap checks per write.

**TTL.** An expired entry is removed when it is read. In addition, each owner gets one sweep per page load, deferred by `requestIdleCallback` on first touch. This is a one-shot, not polling.

**Cap.** A write that would take the owner over its cap first drops expired entries. Then the owner's declared policy applies:

- `evict-oldest` (caches: scroll positions, widths, view state) drops entries by oldest `ts`. Each eviction is counted and shown in the health row. No toast.
- `refuse` (drafts, answers) does not write. It is **loud**, as in §3.

The user's text stays in memory, as today.

**Global budget.**

- The sum of `area: "local"` caps must be ≤ 7 MB, leaving headroom under Chrome's ~10 MB for the browser and unowned keys.
- At runtime, `defineStore` asserts this when it registers an owner.
- The `budget-fits` check (§5) enforces it statically across every owner, including deferred-tier plugins not yet loaded.

With per-owner caps summing under the quota, no owner can starve another, which is the guarantee the drafts need. The session area gets its own budget the same way.

### 2. `persistent-draft` sits on top

The draft API takes a store handle instead of a free key string:

- `useDraft(store, scope?)`
- `readDraft(store, scope)`
- `writeDraft(store, scope, v)`

Because the API requires a handle, every draft owner must declare one: tsc rejects an undeclared draft.

- `persistent-draft` keeps the reactive hook, the same-tab sync event and `onDraftWritten`.
- Its own envelope, key grammar and TTL code are deleted.
- `onDraftWriteFailed` becomes the primitive's `onStorageWriteFailed`.
- `unsaved-warning` moves to the primitive (§3).

**Migration.** Each owner's `legacyKeys` deletes its old `singularity:draft:<key>` entries. They are not ported: they are ≤7-day drafts. **Exception:** prompt drafts are copied once into the new key, so no unsent text is lost.

### 3. Loud failures

The primitive emits `onStorageWriteFailed({ owner, label, reason: "over-cap" | "quota" | "blocked" })`. It has no dependency on toast or reports.

Two companion sub-plugins listen to it:

- `web-storage/plugins/failure-toast`, generalised from `persistent-draft/unsaved-warning`. It shows an error toast once per owner per page load: "<label> are not being saved", with the reason. It has an action that opens the health report.
- `reports/plugins/web-storage`, following the `resource-errors` pattern: the primitive declares `defineReportSink`, and a `Core.Root` collector maps each failure to `report({ kind: "storage-refused" })`. Reports are deduped by fingerprint, `(owner, reason)`, so a refused write still reaches Reports when nobody sees the toast.

**Unguarded paths.** The unguarded `setItem` calls in `tabs-store` and `last-app` disappear with the migration. The unguarded `JSON.parse` in `data-view` becomes a `corrupt` result.

### 4. Health-report row

The primitive contributes `HealthReport.Row({ kind: "status", id: "browser-storage", title: "Browser storage", … })`.

**`useStatus`** reads in-memory counters only, so it stays cheap:

| State | When |
|---|---|
| `critical` | The browser refused a write this page load (quota or blocked) |
| `attention` | An owner refused at its cap, or total local use is over 80 % of 10 MB |
| `ok` | Otherwise. Summary: "3.1 MB of 10 MB" |

**`glance`** is a fill bar.

**`component`** (mounted only when expanded) is a **DataView** with one row per owner, built from a full key scan:

- Columns: owner, area, used / cap, keys, TTL, evictions this load.
- Owners that are declared but not loaded yet appear as their prefix.
- Two extra buckets: **Unowned** (third party and leftovers) and **Legacy**.

### 5. Enforcement

**Lint rule `web-storage/no-raw-web-storage`.** It flags any global reference to `localStorage` / `sessionStorage`, including `window.*`. It reuses the `globalScope.through` detection from `dom-access-safety/no-module-scope-dom`.

- Test and e2e files are out of scope by default, since they seed storage on purpose.
- The primitive's `web/internal` gets a `sanctioned` exemption in its own `exempt/index.ts`.

**Check `web-storage:budget-fits`.**

- It collects every `defineStore({...})` call through the plugin-refs/ts scanner and requires literal `owner` / `area` / `cap`.
- It fails when owners collide, or when either area's caps exceed its budget.
- This is the build-time half of the global-budget guarantee, so it covers deferred plugins too.

**frimousse.** The emoji picker passes a `resolveEmojiData` that fetches the mirrored data with no storage cache (the HTTP cache covers it). The old `frimousse/*` keys are cleared by a `legacyKeys` on the emoji plugin's store. That store is declared with a tiny cap and holds nothing else.

### 6. Migration order (one session if it fits)

1. Primitive, toast, report sink, health row, check. Then `persistent-draft` rewired onto it, all ~25 draft owners declared, and caps chosen from the measured sizes.
2. Layout state that loses data silently today: `pane-restore` and `miller` widths/collapse.
3. The remaining direct callers:
   - `data-view`
   - `view-switcher`
   - `tabs-store`
   - `last-app`
   - `desktop/windows`
   - `tab-id`
   - `app-instance`
     - Its cross-owner sweep becomes a primitive API: `removeWhere(tabId)` per store, or an `instanceScoped` flag the primitive sweeps. Today it scans every key in session storage.
   - `live-state` debug flag
   - `theme-engine` / `pending-turn` legacy removals, which become `legacyKeys`
4. Lint rule on: it lands last, once the codebase is clean, so the check run is green.

**Caps (initial, from measurements):**

| Owner | Cap | Policy |
|---|---|---|
| Prompt drafts | 1 MB | refuse |
| Ask-user answers | 256 KB | refuse |
| Transcript scroll | 256 KB | evict-oldest; today 1.08 MB of near-dead entries |
| `pane-restore` | 256 KB | evict-oldest |
| `miller` widths | 64 KB | evict-oldest |
| `data-view` state | 512 KB | evict-oldest |
| Small prefs | 16 KB each | |

The local caps sum to well under 7 MB.

## Critical files

- **New:** `plugins/primitives/plugins/dom/plugins/web-storage/{core,web,lint,check,exempt}/`, plus `plugins/failure-toast/`.
- **New:** `plugins/reports/plugins/web-storage/`.
- **Rewritten:** `plugins/primitives/plugins/persistent-draft/web/{draft-storage,use-draft}.ts`.
- **Moved:** `persistent-draft/plugins/unsaved-warning` is folded into `failure-toast`.
- **Reused:**
  - `HealthReport.Row` (`shell/plugins/health-report/web/slots.ts`)
  - `showToast` (`shell/plugins/toast/web`)
  - `defineReportSink` (`primitives/plugins/report-sink/core`)
  - `report()` (`reports/web`)
  - `Exemptions` (`tooling/plugins/exempt/core`)
  - `LintContribution` (`tooling/plugins/lint/core`)
  - `ZodParser` (`packages/zod-parser`)
- **Migrated** (one representative per kind): `conversations/plugins/pane-restore/web/internal/pane-restore-store.ts`, `layouts/plugins/miller/web/hooks/use-column-widths.ts`, `apps-core/plugins/tabs/web/internal/tabs-store.ts`, `ui/plugins/icons/plugins/emoji/web/components/emoji-picker.tsx`.

## Verification

**Unit tests** (vitest, jsdom). Use a quota-limited `Storage` fake in `web-storage/web/testing/` that throws `QuotaExceededError` past N bytes. Cover:

- Cap refuse vs evict-oldest
- TTL sweep
- Corrupt read
- Cross-tab `storage` event accounting
- Duplicate or overlapping owner throws
- A refused write fires `onStorageWriteFailed`

**Repo checks.** Run `./singularity check`, which covers `budget-fits` (with a fixture over budget to see it fail), the lint rule and exemptions.

**In the app.** Deploy with `./singularity build`. Then:

1. With `browser_*`, fill localStorage to the quota with unowned junk, type a prompt draft and reload.
2. Expect a toast once, the health row critical with Unowned as the culprit, and a Reports entry.
3. With a fresh quota, check the row's per-owner DataView matches `Object.keys(localStorage)` grouped by prefix.
4. Check the legacy `singularity:draft:*` and `frimousse/*` keys are gone after the first load.
5. Check a prompt draft typed before the migration survives it.
