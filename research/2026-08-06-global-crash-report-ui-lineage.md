# Crash reports carry their UI composition lineage

**Date:** 2026-08-06
**Category:** global (`primitives/ui-context`, `primitives/error-boundary`, `reports/crash`, `reports/launch-fix`, `reports/render-loop`)

## Context

When a React error boundary catches a crash, the only location the report carries
is a single string. For a slot contribution that string is the slot id
(`ErrorBoundaryMiddleware` passes `slot={slotId} label={pluginId}`); for content
inside a portaled overlay it is the `OverlayBoundary` `kind` — `popover`,
`dialog`, `dropdown`, `select`, `tooltip`, `floating`.

That `kind` has no per-value logic anywhere: it lands in `report.slot`, is not
part of `crashFingerprint` (which is `errorType` + top-3 normalized stack
frames), and changes no styling or behavior. But it is not decoration either —
it is the *entire* attribution an overlay crash carries, and it reaches four
places: the fallback's visible tag, the persisted `data.slot`, the filed
investigation task (`**Slot:**`), and the fix-agent prompt (`**Location:**`).
It exists because React error boundaries follow the React tree *including
portals*, so without `OverlayBoundary` a throw inside dropdown content would
propagate to the enclosing slot boundary and be filed under whatever slot the
**trigger** happened to sit in.

So an agent sent to fix a crash learns "something under `dropdown` threw" — not
which plugin, which slot, or which pane/column/tab of the screen it was in.

Meanwhile `primitives/ui-context` already answers exactly that question, and its
own CLAUDE.md names the two consumers it was built as a neutral leaf for:
`improve/element-picker` and `reports/render-loop`. The second was never wired
up — `render-loop` hand-rolls a parallel copy of the walk instead, and the two
have since **diverged** in a way that mis-attributes.

**Outcome:** a crash report carries the composition path of the subtree that
threw — plugin, slot, contribution, and the named screen region — as the same
`<ui-context …>` token the element-picker already produces, so it renders as the
existing inline chip and reads to an agent as a shape it already knows. And the
two copies of the DOM walk become one.

## What lands

| Area | Change |
|---|---|
| `ui-context` | `<ui-context>` gains a **provenance**; three shared DOM walks become exports; a lineage-only meta builder |
| `error-boundary` | `CrashFallback` collects the lineage from its own mount point |
| `reports/crash` | payload carries `uiContext`; the filed task renders the token |
| `reports/launch-fix` | the fix-agent prompt carries the token |
| `reports/render-loop` | imports the three walks instead of its diverged copies |

---

## Part 1 — `primitives/ui-context`

### 1a. Provenance on the token

The token's eight attributes (`url` `plugin` `slot` `contribution` `path`
`selector` `source` `owner`) are already fully generic. Only the body is
picker-specific: a hardcoded `HINT` that says *"The user pointed at this element
… using the element-picker inspector"*, and a `<picked-content>` label tag. Both
would lie for a crash.

**`core/internal/token.ts`** — introduce provenance as closed data, mirroring the
file's existing "single source of truth + compile-time check" idiom:

```ts
export type UiContextProvenance = "picked" | "crash";

// Closed set: both runtimes need it and it is enumerable today, so it is plain
// data in core/ rather than a slot (per the collection-vs-closed-list rule).
const PROVENANCE = {
  picked: {
    bodyTag: "picked-content",
    hint: "The user pointed at this element in the live app using the element-picker inspector; it is the UI element their request refers to.",
  },
  crash: {
    bodyTag: "crash-site",
    hint: "A React error boundary caught a crash here. The path names the plugin, slot and screen region the throwing subtree occupied; the throwing component itself is named by the component stack.",
  },
} as const satisfies Record<UiContextProvenance, { bodyTag: string; hint: string }>;
```

- `serializeUiContext(meta, provenance)` — second parameter is **required**, not
  defaulted. Two existing call sites (`element-picker-button.tsx:14`,
  `task-draft-picker-button.tsx:15`) pass `"picked"`. A default would let a
  future producer silently ship the wrong hint.
- `parseUiContext` — match the body across every registered `bodyTag`
  (alternation built from `PROVENANCE`), keeping the existing
  `LEGACY_BODY_PREAMBLE` fallback. `UI_CONTEXT_RE` needs **no change** — its body
  is already `[\s\S]*?` up to `</ui-context>`.
- `UI_CONTEXT_FIELDS` is untouched. Provenance is deliberately **not** a
  `UiContextMeta` field: it describes why we are emitting, not where the element
  is, and adding a non-`string` union to the meta would break both the
  `Exclude<keyof UiContextMeta, "element">` exhaustiveness check and
  `parseUiContext`'s `meta[f.key] = v` assignment.

### 1b. A wire schema for `UiContextMeta`

`reports/crash` needs to validate the meta on ingest. Add to `core/internal/token.ts`:

```ts
export const UiContextMetaSchema = z.object({ /* url required, rest optional */ });
```

Bind it to the interface with a mutual-assignability check, the same trick
`_allFieldsRegistered` already uses in this file — so schema and interface cannot
drift:

```ts
type _SchemaMatches =
  z.infer<typeof UiContextMetaSchema> extends UiContextMeta
    ? UiContextMeta extends z.infer<typeof UiContextMetaSchema> ? true : never
    : never;
const _schemaMatchesType: _SchemaMatches = true;
void _schemaMatchesType;
```

### 1c. Extract the three shared walks

New **`web/internal/marker-walk.ts`**, holding the current bodies from
`collect-meta.ts:36-83` verbatim:

- `isMarkerSpan(el)` — keyed on `data-lineage`, the grammar's discriminator,
  which covers **both** producers (the contribution middleware *and* `<UiRegion>`)
- `nearestSource(el)` — nearest build-stamped `data-source="file:line"`
- `nearestOwner(el)` — nearest `data-ui-owner="Name@file:line"`

`collect-meta.ts` imports them and deletes its local copies. All three are
re-exported from `web/index.ts` for `render-loop` (Part 4).

### 1d. `collectLineageMeta` — the ancestors-only builder

New **`web/internal/collect-lineage-meta.ts`**:

```ts
export function collectLineageMeta(el: Element, element: string): UiContextMeta
```

Returns `url`, `element`, and only the lineage-derived fields — `path` (via
`formatLineagePath`), plus `pluginId`/`slotId`/`contributionId` from the
innermost node, exactly as `collectMeta` derives them.

It deliberately omits `selector` / `source` / `owner`. Those are computed from
the element *itself*, and the crash caller's element is the fallback — whose own
`<Line>` is JSX in `crash-fallback.tsx` and therefore carries
`data-source="…/crash-fallback.tsx:57"`. Emitting them would name the error
boundary as the crash site. The React-side answer (which component actually
threw) is already carried by `componentStack`.

Putting this in `ui-context` rather than inlining three lines in `error-boundary`
keeps "which fields an ancestors-only walk may honestly claim" in the plugin that
owns the walk.

---

## Part 2 — `primitives/error-boundary`

Both boundary classes (`PluginErrorBoundary`, and the `OverlayBoundary` fallback
registered at `web/index.ts:28`) funnel into **`CrashFallback`**, which is the
single collection point — and it renders in the crashed subtree's exact position,
so *its ancestors are the crash site*.

**`web/reporter.ts`** — add to `BoundaryErrorReport`:

```ts
uiContext?: UiContextMeta | null;
```

Optional: the two boundary classes construct the report before any DOM exists;
`CrashFallback` fills it in after the walk.

**`web/components/crash-fallback.tsx`**:

- `ref` on the root `<Line>` (`LineProps` already forwards `ref`).
- Inside the existing `useEffect` — already deferred one tick via
  `setTimeout(…, 0)`, so the fallback is mounted — call
  `collectLineageMeta(ref.current, tag || "Plugin")`. `tag` is the
  `[slot, label]` string the component already computes; for an overlay crash
  that is the `kind`, which is what keeps `kind` earning its place as the label.
- Thread the result into **both** consumers: the `boundaryReportSink.emit(...)`
  payload, and the `report` object passed to `ErrorBoundary.Action` contributions
  (held in state alongside `context`).

Portals need no special handling: `collectLineage` already splices
`data-plugin-lineage` off the portaled positioner (`collect-lineage.ts:29`), so
an overlay crash resolves the **originating** tree's lineage — strictly more than
the string `dropdown`.

Degradation is expected and fine. Contribution nodes come from
`PluginMarkerMiddleware`, which lives in `improve/element-picker` and is
deliberately opt-in, so the contribution half exists only when that plugin is in
the composition. Region nodes (`<UiRegion>` in `layouts/miller`,
`layouts/full-pane`) are unconditional. A region-only or empty `path` is a
legitimate outcome, not a failure — `error-boundary` must not import
`element-picker`.

---

## Part 3 — `reports/crash` and `reports/launch-fix`

The `data` column is free-form `jsonb` (`reports/server/internal/tables.ts:36`),
so **no migration is required**.

- **`crash/core/crash-kind.ts`** — add `uiContext: UiContextMetaSchema.nullable().optional()`
  to `CrashPayloadSchema`. Keep the existing `slot`/`label`: they are the
  boundary's own view, available with no DOM walk and no middleware installed.
  Leave `crashFingerprint` **unchanged** — location must not split the
  fingerprint for one bug.
- **`crash/web/components/crash-collector.tsx:51`** — pass `uiContext: r.uiContext ?? null`
  in the `react-boundary` sink handler.
- **`crash/server/internal/render-crash-task.ts:84`** — where it currently emits
  `**Slot:**`, also emit `serializeUiContext(data.uiContext, "crash")` when
  present. Conditional: the `browser-error`, `browser-rejection` and
  `live-state-wedge` sources have no `uiContext`.
- **`launch-fix/web/components/launch-fix-button.tsx:61-88`** — the fix prompt is
  built **client-side from the live `BoundaryErrorReport`**; it never reads back
  the persisted row. Emit the token there too, beside the existing
  `**Location:**` line.

Because the token is what ships, the prompt renders as the existing inline chip:
`element-picker` registers `ActiveData.Tag({ pattern: UI_CONTEXT_RE, component: UiContextTag })`
(`element-picker/web/index.ts:22`), and `UiContextChip` is already generic — it
renders `meta.element` and iterates `UI_CONTEXT_FIELDS`, so `path` surfaces with
no edit. Where `element-picker` is absent the token degrades to raw text, which
the agent still reads fine.

---

## Part 4 — `reports/render-loop`

`culprit-signature.ts` re-implements the same three walks. `nearestSource` and
`nearestOwner` are structurally identical; `isMarkerSpan` has diverged:

| | discriminator | covers |
|---|---|---|
| `ui-context` | `el.dataset.lineage !== undefined` | contribution middleware **and** `<UiRegion>` |
| `render-loop` | `el.dataset.slotId !== undefined` | contribution middleware only |

`<UiRegion>` renders `<span style={{display:"contents"}} {...regionNodeAttrs(node)}>`
(`ui-region.tsx:52`), and `regionNodeAttrs` sets `data-lineage` / `data-region-*` /
`data-plugin-id` — **no `data-slot-id`**. That span is lowercase JSX, so the
source-location babel transform stamps `data-source=".../ui-region.tsx:52"` on
it. render-loop therefore does not skip it, and any culprit whose own element
lacks `data-source` resolves to **`ui-region.tsx`** — for anything inside a
miller column or a full-pane. `collect-meta.ts:44-49` documents this exact
failure mode as the reason its discriminator is keyed on `data-lineage`.

**Change:** delete the three local helpers from `culprit-signature.ts` and import
them from `@plugins/primitives/plugins/ui-context/web`.

**Explicitly kept local** — genuinely bespoke to a detector, with no stake for a
neutral leaf:

- `boundedPath` — `nth-of-type`, depth-4, ceiling at the nearest stable anchor.
  Chosen for churn-robustness; `ui-context`'s `preciseSelector` is id/testid-first
  and human-readable. Different goals, not redundancy.
- `signature` — the joined `Map` key that survives React teardown/rebuild.
- `aggregateRoot` — the coarse rollup for the subtree-cascade tier.
- `nearestMarker` and the `data-pane-id` read — `data-pane-id` is a separate,
  older convention with independent readers (miller's width/maximize/collapse
  hooks, `full-pane`, `route-fallback`, pane `history-sink`, `pane-restore`, e2e
  scripts), and `ui-context`'s CLAUDE.md declares it out of scope by name.

---

## Boundary and cycle check

- `error-boundary/web` → `ui-context/web` → `ui-kit/web`. `ui-kit` imports
  neither `ui-context` nor `error-boundary` (verified) — that separation is
  precisely why `overlay-boundary` exists as a leaf below `ui-kit`. No cycle.
- `reports/crash/core` → `ui-context/core`, `reports/crash/server` and
  `reports/launch-fix/web` → `ui-context/core`, `render-loop/web` →
  `ui-context/web`. All runtime barrels; all legal.
- `ui-context/core` gains a `zod` import (already a repo-wide dependency).

## Behavior deltas and risks

1. **render-loop fingerprints churn once.** `source` and `owner` are components
   of the `signature` `Map` key, and `renderLoopFingerprint` is keyed on
   signature + mutation class. Culprits that previously resolved to
   `ui-region.tsx` will re-fingerprint, so open render-loop tasks will not dedupe
   against post-change reports. One-time, and the new value is the correct one.
2. **`serializeUiContext` becomes 2-arity.** Two call sites, both in
   `element-picker`. Intentionally not defaulted.
3. **Pre-existing, noted not fixed:** `PluginErrorBoundary` renders twice on a
   catch (`getDerivedStateFromError`, then `componentDidCatch`'s `setState`),
   constructing a fresh `report` object literal each time. `CrashFallback`'s
   effect is keyed on `[report]`, so the crash is emitted twice — deduped
   server-side by fingerprint, but it double-counts `count`. This change adds a
   DOM walk to that effect (harmless, but it now runs twice). Worth a separate
   task rather than folding a boundary-lifecycle fix into this one.

## Verification

1. `./equin build` — regenerates the autogen doc blocks; the
   `plugins-doc-in-sync` and `plugin-boundaries` checks must stay green.
2. **Token round-trip** — extend `plugins/primitives/plugins/ui-context/core/internal/token.test.ts`
   with a `"crash"`-provenance serialize→parse case and a legacy-body case:
   ```bash
   bun test plugins/primitives/plugins/ui-context/core/internal/token.test.ts
   ```
3. **Lineage reaches the report** — new vitest beside the existing
   `crash-fallback-truncate.test.tsx`, at
   `plugins/primitives/plugins/error-boundary/web/__tests__/crash-lineage.test.tsx`:
   render `<UiRegion kind="pane" id="p1" label="column 1 of 1"><PluginErrorBoundary slot="X"><Thrower/></PluginErrorBoundary></UiRegion>`,
   register a `boundaryReportSink` handler, assert the emitted report's
   `uiContext.path` contains `#pane:p1[column 1 of 1]`.
   ```bash
   bun run test:dom plugins/primitives/plugins/error-boundary
   ```
4. **No regression in the portal path**:
   ```bash
   bun run test:dom plugins/improve/plugins/element-picker   # portal-lineage.test.tsx
   ./equin test plugins/reports/plugins/render-loop
   ```
5. **End to end** — after `./equin build`, trigger a real boundary crash in
   the app, then confirm with the `query_db` MCP tool:
   ```sql
   SELECT data->'uiContext'->>'path', data->>'slot'
   FROM reports WHERE kind = 'crash' ORDER BY last_seen_at DESC LIMIT 5;
   ```
   Then click **Fix** on the crash banner and confirm the launched conversation's
   prompt contains the `<ui-context … path="…">` tag and renders as an inline
   chip whose popover shows a **Path** row.

## Out of scope

- `parseUiContext` does not return the detected provenance, so `UiContextChip`
  renders a crash token with the picker's `MdAdsClick` icon and "UI element
  context" tooltip. Cosmetic; a follow-up can widen the parse result and pick the
  icon per provenance.
- Moving `UiContextTag` / `UiContextChip` down out of `element-picker` so the chip
  renders without that plugin in the composition. Now that the token has a second
  producer this is arguably right, but it is a separate move.
- The double-emit in `PluginErrorBoundary` (see Risks #3).
