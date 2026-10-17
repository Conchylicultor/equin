# Companion contributions: runtime companions ship with their owner

Track: wiki *Mental model → Plugin system → Composition* (block-6b4d4ded…),
mental model sub-page block-136ef01b-5cd2-4d6a-a212-7d48b46425bf.
Predecessor: `research/2026-10-15-global-token-usage-closure-edges.md` (its *Follow-up* section).

## Context

A composition bundles the hard closure of its entries. Contributions are soft and opt-in,
on purpose. Some contributors are needed at runtime by a capability that never imports
them, so they drop out of every bundle that doesn't hand-list them in `served-baseline`
(`plugins/plugin-meta/plugins/composition/core/config.ts`). Each entry there was added
after an equin.ai incident:

| Companion | Needed by | Wired today | Without it |
|---|---|---|---|
| `ui.icons.sprites` | `ui.icons` (`<Icon>`) | `Core.Root` mount filling `provideSprite` | every icon blank |
| `ui.tokens.icons` (IconThemeBridge) | `ui.icons` | `Core.Root` mount calling `usePublishIconStyle` | wrong icon style |
| `ui.tokens.font-family.google-fonts` | `ui.tokens.font-family` | `Core.Root` mount | theme fonts never load |
| `reorder` (+ `reorder.**` node types) | `primitives.slot-render` | imperative `registerSlotList/ItemMiddleware` | slots ignore committed layouts |

The only edge that exists points at `Core.Root` (web-sdk), which is the wrong owner.
Pulling on it would ship every root mount.

Agreed design: requiredness lives on the **contribution**, with the owner's consent.
A slot opts in with `companions: true`. A contribution to that slot may say
`companion: true`, and then it ships whenever the slot's owner ships. Everything else
stays opt-in. Usage-derived edges (DataView field cells) are the next task, not this one.

## Design

### 1. The API (web-sdk + slot-declaration)

- `SlotMeta` gains `companions?: true` (`framework/slot-declaration/core/declaration.ts`).
- `defineSlot<P>(opts)` in `framework/web-sdk/core/slots.ts` takes `companions?: true`.
  It stamps `meta.companions`, and with it the call signature becomes
  `Slot<P & { companion?: true }>`. Overloads keep the plain case `Slot<P>`, so
  `Core.Root({ component, companion: true })` is an excess-property **type error**:
  no plugin can make itself a companion of a slot whose owner didn't agree.
- slot-render's constructors (`defineMountSlot`, `defineRenderSlot`, …) forward the
  option, so any slot kind can opt in.
- New helper: `defineRootSlot({ companions })` in web-sdk core, next to `Core.Root`. It
  is a slot of `{ id, component }` whose `.Mount` renders each contribution the way
  `App.tsx` renders `Core.Root`. A capability owner contributes
  `Core.Root({ component: X.Root.Mount })` once, and its companions contribute to
  `X.Root`. There are two users (icons, fonts), so it's a helper rather than copied code.
  `ui.icons` cannot import slot-render (ui-kit draws icons, so that would be a cycle),
  which is why this lives in web-sdk.

### 2. The facet (static, browser-safe)

- `Contribution.companion?: true` in `facets/plugins/contributions/core/types.ts`,
  read in `facet/index.ts` from the inline props (`props.companion === "true"`).
- A `companion:` value that is not the literal `true` **throws**, naming the file. The
  engine can only trust what it can read.
- Runtime half: `DocMetaContribution.companion` is read off the imported contribution.
- New check `closure:companions-visible` (barrel-import mode): every runtime contribution
  with `companion: true` must appear in the static half. A companion built outside the
  inline `contributions: [ … ]` literal is otherwise silently soft, and that is the
  exact incident this track exists to remove.

### 3. The engine (`plugin-meta/closure/core`)

- `classifyEdges`: for each static contribution with `companion`, add a **hard edge
  owner → contributor** (owner = `groupOwner` of the slot's group, the same lookup soft
  edges use). The soft edge stays as it is.
- `Edge.via` becomes `"import" | "token" | "companion"`. Precedence when several hold:
  import > token > companion. Update `serialize.ts` and Studio's inclusion-path wording
  ("ships as a companion of `ui.icons`").
- Everything downstream inherits it unchanged, as with token edges: `hardClosure`,
  `available` (a companion is no longer an option), the negation cascade (negating
  sprites removes `ui.icons` and its importers, and `unsatisfiedExclusions` reports it
  loudly), `explainInclusion`, `composition-closure`, registry codegen.
- Document it in `closure/CLAUDE.md` § *Edge classification*.

### 4. Apply it

**Icons.** `ui.icons` declares `Icons.Root = defineRootSlot({ companions: true })` and
contributes `Core.Root({ component: Icons.Root.Mount })`. `ui.icons.sprites` and
`ui.tokens.icons` move their `Core.Root` mount to
`Icons.Root({ id, component, companion: true })`. Both already import `ui.icons`, so
there is no new cycle.

**Fonts.** `ui.tokens.font-family` declares `FontFamily.Root` the same way.
`google-fonts` contributes its loader as a companion.

**Slot middleware.** `slot-render`'s module-level registry (`internal/registry.ts`) is
invisible to every tool. It becomes three declared slots, all `companions: true`:
`SlotRender.ListMiddleware`, `SlotRender.ItemMiddleware`, `SlotRender.ItemAttrs`.
Contributions carry `{ id, priority, Component }` (attrs: `{ id, attrs }`).

- **Reading.** `.Render` reads list middleware with a hook at its top. Item middleware
  and attrs are applied by a small `<ItemMiddlewares>` component that
  `applyItemMiddlewares` returns, so `renderIsolated` and every other call site stays a
  plain function. Priority sort is memoized per contribution list.
- **Delete** `registerSlotItemMiddleware` / `registerSlotListMiddleware` /
  `registerSlotItemAttrs`.
- **Migrate the registrants:**
  - `error-boundary`'s middleware is a **companion**: isolation is required wherever
    slots render.
  - `pane`'s title guard is a plain contribution, pushed into its existing live
    `paneHeaderContributions`. It matters only when `pane` ships, and it ships with
    `pane`.
  - element-picker's marker middleware and lineage attrs are plain contributions
    (optional, self-improvement pack).
  - The two tests that register middleware provide it through `PluginProvider`.
- **Reorder.** Its `contributions` is the live array the declaration pass rewrites, so
  an inline companion can't sit there. New sub-plugin `reorder.slot-middleware`: its
  barrel inline-contributes the list and item middleware (`companion: true`), imported
  from `@plugins/reorder/web`. Pulling it pulls `reorder` through the import. This is
  also the seam the apply/edit split will cut along later.
- **Node types.** `reorder.node-types` marks its slot `companions: true` and its four
  children (divider/header/overflow/spacer) flag their contributions as companions.
  This replaces the baseline's `reorder.**` subtree.

**Load tier.** Companions currently ride `Core.Root`, a watched boot slot that makes them
eager. Every plugin touched here is non-app-content, so it stays eager structurally.
Confirm `eager-tier-in-sync` shows no diff.

### 5. Shrink `served-baseline`

Remove `reorder`, `shell.toast` (already imported by `infra.health`),
`ui.tokens.font-family.google-fonts`, `ui.icons.sprites` and `ui.tokens.icons`, together
with their incident comments. Keep `apps-core.layout`, `infra.health`,
`primitives.dom.overscroll-hint` and `ui.theme-engine` (being-served requirements).
Update the pins in `composition/core/config.test.ts`.

## Out of scope (track items)

- Usage-derived edges (DataView view renderers and field cells): the next task.
- Splitting reorder's apply from its DnD editor.
- The dead-end check and the runtime asserts (blank-icon / unapplied-layout made loud).
- `overlay-boundary`'s `registerOverlayFallback`, another imperative registry. It's
  harmless today because error-boundary is imported, so it's noted only.

## Critical files

- `plugins/framework/plugins/slot-declaration/core/declaration.ts`: `SlotMeta.companions`
- `plugins/framework/plugins/web-sdk/core/slots.ts`: option, overloads, `defineRootSlot`
- `plugins/primitives/plugins/slot-render/web/internal/{render-slot.tsx,registry.ts,types.ts}`, `web/index.ts`
- `plugins/plugin-meta/plugins/facets/plugins/contributions/{core/types.ts,facet/index.ts}`
- `plugins/plugin-meta/plugins/closure/core/{types.ts,classify-edges.ts,serialize.ts,inclusion-path.ts}`, `CLAUDE.md`, new `check/`
- `plugins/ui/plugins/icons/web/{index.ts,slots.ts}`, `…/icons/plugins/sprites/web/index.ts`, `plugins/ui/plugins/tokens/plugins/icons/web/index.ts`
- `plugins/ui/plugins/tokens/plugins/font-family/web/index.ts`, `…/google-fonts/web/index.ts`
- `plugins/reorder/web/index.ts`, new `plugins/reorder/plugins/slot-middleware/`, `plugins/reorder/plugins/node-types/**/web/index.ts`
- `plugins/primitives/plugins/{error-boundary,pane}/web/…`, `plugins/primitives/plugins/ui-context/plugins/element-picker/web/…`
- `plugins/plugin-meta/plugins/composition/core/{config.ts,config.test.ts}`

## Verification

1. **Types:** `Core.Root({ component, companion: true })` fails tsc (a `@ts-expect-error`
   test in web-sdk).
2. **Unit:**
   - `classifyEdges` gives `ui.icons → ui.icons.sprites` (`via: "companion"`),
     `slot-render → reorder.slot-middleware`, and no edge `slot-render → element-picker`.
   - The static parse throws on `companion: someVar`.
   - slot-render tests: middleware from slot contributions applies in priority order.
3. **Bundle diff:** a one-off `./singularity run` script resolves every committed
   composition with the old graph and config, then the new ones.
   - Expect `after ⊇ before`. The only additions should be `reorder.slot-middleware`
     and anything it legitimately reaches. The script prints the additions so they can
     be judged.
4. `./singularity build`. All checks green, including `composition-closure`,
   `plugins-registry-in-sync`, `eager-tier-in-sync`, `plugins-doc-in-sync` and the new
   `closure:companions-visible`.
5. **Real served page:** serve the `website` composition and check with `screenshot.ts --composition website`:
   - icons draw (the Improve sparkle);
   - a slot with a committed layout renders in its layout order;
   - theme fonts load.

   Also check main at `http://<worktree>.localhost:9000`.
