# Slot-render: `defineMountSlot` + reorder-by-default (delete the `reorder` flag)

## Context

`defineRenderSlot` carries a `reorder?: boolean` option (default `true`). Nine slots pass `reorder: false`. Auditing them showed the flag conflates three structurally different things under one constructor:

- **Headless mount** — `sonata.effect`: contributions render *nothing* (side effects). They run through `.Render` purely for per-contribution error-boundary isolation; "order" is meaningless because nothing is visible.
- **Visible lists that simply shouldn't have opted out** — `card-meta`, `variant-group`, `exit-menu.item`, `jsonl-viewer.overlay`, `turn-into`, `hud`, `transport`, `home`. Each is (or is explicitly designed to become — see the "and future widgets" comments on `transport` at `library/web/panes.tsx:171` and the full-area landing surface `home`) a multi-contribution visual surface. These should be reorderable like every other render slot.

There is no genuine "singleton" among them — `home`/`transport` are single-contributor *today* but structurally open-ended lists, so a dedicated singleton primitive isn't warranted.

The result: `reorder` is a footgun (forget it means "author no override"; or accidentally opt a real list out of user curation), and it lets a non-visual slot masquerade as a render slot. The clean design makes slot **kind** explicit in the *constructor* and deletes the boolean:

- `defineRenderSlot(id)` — visible, renders all contributions isolated, **always reorderable** (no opt-out).
- `defineMountSlot(id)` — **headless**, renders all contributions isolated, **never reorderable / not in the reorder manifest**. The component type is constrained to `(props) => null`, a *compile-time* guarantee that mount components render nothing.
- `defineDispatchSlot` / `defineSlot` — unchanged.

Secondary cleanup folded in: `conversation.exit-menu.item` currently hardcodes a numeric `order` prop and sorts in the host. Once it's a normal reorderable slot, its order belongs in the config override file (config_v2 `items` tree), not in code.

## Outcome

- One new constructor (`defineMountSlot`); `reorder?: boolean` removed everywhere (config type, runtime, facet, codegen).
- `effect` is the only mount slot; the other 8 become unconditionally reorderable and ship authored config overrides.
- Exit-menu order is data (config jsonc), not code.
- Runtime behavior is unchanged for every existing slot (verified: `reorder:false` today already = item-middleware-only, and the reorder item middleware passes through bare without a list middleware — `dnd-item-middleware.tsx:22-23`).

---

## Design: the API

In `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`:

```ts
/** A headless contribution: mounts for side effects, renders nothing.
 *  Typed as `=> null` so a component that returns JSX fails to compile —
 *  the structural guarantee that a mount slot is non-visual. */
type MountComponent<P = {}> = (props: P) => null;

interface MountSlotConfig<P> {
  docLabel?: (props: P & { id: string }) => string | undefined;
}

interface MountSlot<P> extends Slot<{ id: string; component: MountComponent<P> } & P> {
  /** Mounts every contribution wrapped in item middlewares (error-boundary
   *  isolation), no list/reorder middleware. Prop-less; renders null visually. */
  Mount: ComponentType;
}

export function defineMountSlot<P = {}>(id: string, config?: MountSlotConfig<P>): MountSlot<P>;
```

`.Mount` reuses the *exact* contribution-render path that `.Render` uses today in its non-reorder branch: map `ctx.bySlot.get(id)` → `UNSAFE_unsealSlotComponent(clean.component)` → `applyItemMiddlewares(node, id, contribution)` → `<Fragment key>`. No list middleware, no `controlSize`, no flex sentinel (all irrelevant to invisible content). Factor the existing per-item logic in `renderItem` into a small shared helper so `.Render`'s default path and `.Mount` don't duplicate it.

Why `=> null` and not docs: TS infers a component that only ever `return null`s as `() => null` (assignable to `MountComponent`); any JSX return is `ReactElement` and fails; a conditional `cond ? <X/> : null` is `ReactElement | null` and also fails — correctly rejecting a slot that *sometimes* renders. Compile-time, fail-loud, zero runtime cost. Runtime detection of "did this render anything" is unreliable (portals/effects/fragments), so the type is the guarantee.

---

## Change list

### 1. slot-render primitive — `render-slot.tsx`
- Add `MountComponent`, `MountSlotConfig`, `MountSlot`, `defineMountSlot` (above).
- Remove `reorder?: boolean` from `RenderSlotConfig`; remove `const reorder = config?.reorder ?? true` and the `if (reorder) { …list middleware… }` guard — `.Render` **always** applies the list middleware now.
- Export `defineMountSlot` + `MountSlot`/`MountComponent` from the barrel `plugins/primitives/plugins/slot-render/web/index.ts`.

### 2. Slots facet — recognize the new constructor, drop the reorder concept
`plugins/plugin-meta/plugins/facets/plugins/slots/`
- `core/types.ts`: add `"mount"` to `SlotDef.kind`; **remove the `reorder?: boolean` field** (render = always reorderable, mount = never; reorderability now derives from `kind`).
- `facet/index.ts`:
  - `parseRenderSlots` (~L28-63): drop the `reorder` regex (L58) and the `reorder` field on the emitted object — emit just `kind: "render"`.
  - Add `defineMountSlot` parsing: a fourth `parseDefineGroup(stripped, "defineMountSlot", …)` (or a `parseMountSlots`) emitting `kind: "mount"`.
  - Runtime fallback `collectRuntimeSlots` (~L88-107): detect `.Mount` → `kind: "mount"`; `.Render` → `kind: "render"` (no reorder field).
- **Audit other `SlotDef.reorder` consumers**: `rg "\.reorder\b" plugins/plugin-meta`. Any docgen/slot-detail renderer that showed "reorderable" must derive it from `kind === "render"` instead.

### 3. Codegen + check
- `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`, `collectReorderableSlots` (~L74-79): the filter becomes just `if (slot.kind !== "render") continue;` (drop the `slot.reorder === false` line — the field is gone). Mount slots (`kind: "mount"`) are excluded automatically.
- `reorderable-slots-in-sync` check (`…/checks/plugins/reorderable-slots-in-sync/`): no edit — it's a pure drift detector; `./equin build` regenerates the manifest.

### 4. `effect` → mount slot
- `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts`: `Effect: defineMountSlot("sonata.effect", { docLabel: (p) => p.id })` (was `defineRenderSlot<{ component: ComponentType }>(…, { reorder: false, … })`).
- Host `…/shell/web/components/sonata-layout.tsx:20-22`: replace the render-prop block with `<Sonata.Effect.Mount />`.
- The three contributors (`AudioEngine` `audio-engine.tsx:286`, `SeekHoldController` `seek-hold-controller.tsx:87`, `RecordPlayObserver` `record-play-observer.tsx:27`) already `return null` → satisfy `MountComponent` as-is. No contributor-call change (`Sonata.Effect({ id, component })` still type-checks).

### 5. The 8 visible slots → drop `reorder: false`
Plain edits removing the option (now unconditionally reorderable). No host changes — they already render via `.Render`:
- `apps/sonata/shell/web/slots.ts` — `sonata.transport`, `sonata.hud`, `sonata.home`
- `apps/sonata/library/web/slots.ts` — `sonata.library.card-meta`
- `ui/theme-engine/web/slots.ts` — `ui.theme-engine.variant-group`
- `page/editor/web/slots.ts` — `page.editor.turn-into`
- `conversations/…/jsonl-viewer/web/slots.ts` — `conversation.jsonl-viewer.overlay`
- `conversations/…/exit-menu/web/slots.ts` — `conversation.exit-menu.item` (see §6)

### 6. Exit-menu: order as data, not code
- `…/exit-menu/web/slots.ts`: remove `reorder: false` **and** the `order: number` field from the `Item` contribution type → `defineRenderSlot<{ component: ComponentType<{ conversation: ConversationRecord }> }>("conversation.exit-menu.item", { docLabel: (p) => p.id })`.
- The 4 contributors drop `order: N`:
  - `hold-and-exit/web/index.ts`, `exit/web/index.ts`, `drop-and-exit/web/index.ts`, `drop-dependents/web/index.ts`.
- Host `…/exit-menu/web/components/exit-menu-button.tsx`: replace `useContributions()` + `useMemo` sort + `renderIsolated` map with:
  ```tsx
  <DropdownMenuContent align="start">
    <ExitMenu.Item.Render>
      {(item) => <item.component conversation={conversation} />}
    </ExitMenu.Item.Render>
  </DropdownMenuContent>
  ```
  Keep the `if (!conversation) return null` guard. Remove now-unused imports (`useMemo`, `renderIsolated`, `Contribution`, `Fragment`). Order comes from the override authored in §8 (`hold → exit → drop → drop-dependents`).

### 7. `./equin build`
Regenerates `reorderable-slots.generated.ts` (now lists the 8, not `effect`) and emits a `<slotId>.origin.jsonc` per reorderable slot under its defining plugin's `config/` dir.

### 8. Author the 8 config overrides
For each, copy the generated `<slot>.origin.jsonc` → `<slot>.jsonc` (same dir, drop `.origin`, keep the leading `// @hash` line). Paths:
- `config/apps/sonata/shell/sonata.home.jsonc`
- `config/apps/sonata/shell/sonata.transport.jsonc`
- `config/apps/sonata/shell/sonata.hud.jsonc`
- `config/apps/sonata/library/sonata.library.card-meta.jsonc`
- `config/ui/theme-engine/ui.theme-engine.variant-group.jsonc`
- `config/page/editor/page.editor.turn-into.jsonc`
- `config/conversations/conversation-view/jsonl-viewer/conversation.jsonl-viewer.overlay.jsonc`
- `config/conversations/conversation-view/exit-menu/conversation.exit-menu.item.jsonc`

Ordering: **natural order (verbatim copy)** for all except `exit-menu`, whose `items` are arranged `hold-and-exit → exit → drop-and-exit → drop-dependents` (preserving today's `order: 0,1,2,3`). Exact `entryKey`s (`<pluginId>:<id>`) come from the generated origin's legend. `grandfathered-slots.ts` stays empty — every slot is authored.

### 9. Docs
- `plugins/primitives/plugins/slot-render/CLAUDE.md`: document `defineMountSlot` (headless isolated mount, `=> null` type guarantee) alongside `defineRenderSlot`.
- `plugins/reorder/CLAUDE.md`: "every `defineRenderSlot` is reorderable — opt out by using `defineMountSlot` for headless slots" (the `reorder: false` opt-out is gone).
- Autogen reference blocks + `docs/plugins-*.md` regenerate via build (`plugins-doc-in-sync` check).

---

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` | add `defineMountSlot`; remove `reorder` from config + runtime |
| `plugins/primitives/plugins/slot-render/web/index.ts` | export `defineMountSlot`, `MountSlot`, `MountComponent` |
| `plugins/plugin-meta/plugins/facets/plugins/slots/core/types.ts` | `kind: "mount"`; remove `reorder` field |
| `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts` | parse `defineMountSlot`; drop reorder regex |
| `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts` | filter on `kind === "render"` only |
| `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` | effect→mount; drop `reorder:false` on transport/hud/home |
| `plugins/apps/plugins/sonata/plugins/shell/web/components/sonata-layout.tsx` | `<Sonata.Effect.Mount />` |
| `plugins/apps/plugins/sonata/plugins/library/web/slots.ts` | drop `reorder:false` (card-meta) |
| `plugins/ui/plugins/theme-engine/web/slots.ts` | drop `reorder:false` (variant-group) |
| `plugins/page/plugins/editor/web/slots.ts` | drop `reorder:false` (turn-into) |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/slots.ts` | drop `reorder:false` (overlay) |
| `plugins/conversations/plugins/conversation-view/plugins/exit-menu/web/slots.ts` | drop `reorder:false` + `order` field |
| `…/exit-menu/web/components/exit-menu-button.tsx` | render via `.Render` |
| `…/{hold-and-exit,exit,drop-and-exit,drop-dependents}/web/index.ts` | drop `order:N` |
| `config/**` (8 new `.jsonc`) | authored overrides |
| 2 × `CLAUDE.md` | docs |

## Verification

1. `./equin build` — succeeds; regenerates `reorderable-slots.generated.ts` (contains the 8, not `effect`) + the 8 `.origin.jsonc`. Confirms the facet/codegen changes round-trip.
2. `./equin check` — all green. Key checks: `reorderable-slots-in-sync` (manifest matches), `reorder:configs-authored` (every reorderable slot has an authored override; none grandfathered), `type-check` (incl. that a JSX-returning mount component would fail — sanity-test by temporarily making one effect `return <div/>` and confirming a compile error, then revert), `plugin-boundaries`, `plugins-doc-in-sync`.
3. App at `http://att-1781350578-d8qh.localhost:9000` (Playwright `e2e/screenshot.mjs`):
   - **Sonata player** (`/sonata/song/:id`): transport strip + piano roll render; playback still records a play (effect mounts) → confirms `.Mount` isolation path works headlessly.
   - **Exit menu**: open a conversation's Close-options dropdown → items appear in order hold → exit → drop → drop-dependents (now from the override, not `order`).
   - **Edit mode** (pen button): the 8 slots show drag affordances; `effect` contributes no draggable/invisible target (mount slot absent from reorder).
   - **Theme customizer** (Settings → Appearance): variant groups list renders in override order.
4. Targeted unit check (optional): the slots facet has tests — add/adjust a case asserting `defineMountSlot(...)` yields `kind: "mount"` and is excluded from `collectReorderableSlots`.
