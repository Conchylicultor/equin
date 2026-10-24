# z-layers web barrel — one source for the layer name→class map

**Date:** 2026-06-20
**Category:** global (cross-plugin primitive consolidation)
**Surfaced by:** [`research/2026-06-20-css-primitives-audit.md`](./2026-06-20-css-primitives-audit.md) §8.2

## Context

The semantic z-layer ladder (`z-base`…`z-max`, 8 levels) is defined once in
`ui-kit/web/theme/app.css`. But the **name→`z-*` class mapping** — the bit that
turns a `layer` *prop* into a class — is re-derived in four positioning
primitives because `z-layers` exposes only a `lint/` folder, no web barrel:

| Plugin | What it duplicates |
|---|---|
| `css/overlay` | owns `OverlayLayer = base\|raised\|nav\|float\|overlay` + a local `LAYER_CLASS` record (the in-tree slice, 0–40) |
| `css/sticky` | imports the `OverlayLayer` *type* from overlay but **copies** `LAYER_CLASS` locally |
| `css/pin` | imports the `OverlayLayer` *type* from overlay but **copies** `LAYER_CLASS` locally |
| `css/viewport-overlay` | declares its own disjoint `popover\|draw\|max` union + its own local `LAYER_CLASS` record (the portaled slice, 50–9999) |

So one mapping lives in **three independent copies**, and the layer *vocabulary*
is split across two disjoint string unions (`OverlayLayer` vs viewport-overlay's
inline `keyof typeof LAYER_CLASS`) with no shared source. Each copy carries a
comment apologising for itself ("…copied locally because `z-layers` exposes no
web barrel").

The in-tree (0–40) vs portaled (50–9999) split is **intentional and worth
keeping** — in-tree chrome must not be able to out-stack a portaled modal. The
goal is not to merge the two prop vocabularies, but to make them two named
tiers *derived from one ladder*, with the class map resolved in one place.

**Outcome:** give `z-layers` a `web/` barrel exporting the full ladder, the two
tier subtypes, and a `zLayerClass()` resolver. The four primitives import from
it and delete their local copies. Adding/renaming a layer becomes a one-file
edit (plus the `app.css` utility); the three-copy drift risk is gone.

## Design

### New: `z-layers/web` barrel

New file `plugins/primitives/plugins/css/plugins/z-layers/web/internal/layers.ts`:

```ts
/**
 * The single source for the semantic z-layer vocabulary + the name→class map.
 * The ladder itself (the --z-* vars and matching `z-*` @utility classes) is
 * defined in ui-kit/web/theme/app.css; this module is the TS-side resolver so
 * positioning primitives turn a `layer` prop into a class without each copying
 * the map. NEVER a raw z-number.
 */

// name → the `z-*` @utility class (defined in app.css). Source of truth for the
// full ladder and the ZLayer union.
const Z_LAYER_CLASS = {
  base: "z-base",
  raised: "z-raised",
  nav: "z-nav",
  float: "z-float",
  overlay: "z-overlay",
  popover: "z-popover",
  draw: "z-draw",
  max: "z-max",
} as const;

/** Every named layer on the ladder. */
export type ZLayer = keyof typeof Z_LAYER_CLASS;

/** In-tree levels (0–40): elements that stay in document flow — sticky headers,
 *  in-pane floats, full-pane overlays. Out-stacked by every portaled layer. */
export type InTreeLayer = "base" | "raised" | "nav" | "float" | "overlay";

/** Portaled top layers (50–9999): elements portaled to <body> that must
 *  out-stack all in-tree chrome — modals/lightboxes, draw overlay, banners. */
export type PortaledLayer = "popover" | "draw" | "max";

// Compile-time guard: the two tiers must EXACTLY partition the ladder, so a new
// layer added to Z_LAYER_CLASS can't silently belong to neither tier.
type _Partition = [InTreeLayer | PortaledLayer] extends [ZLayer]
  ? [ZLayer] extends [InTreeLayer | PortaledLayer]
    ? true
    : never
  : never;
const _assertPartition: _Partition = true;
void _assertPartition;

/** Resolve a named z-layer to its `z-*` utility class — the one place the
 *  name→class map is read. */
export function zLayerClass(layer: ZLayer): string {
  return Z_LAYER_CLASS[layer];
}
```

New barrel `plugins/primitives/plugins/css/plugins/z-layers/web/index.ts`
(mirrors the sibling primitive barrels — only re-exports + a single
`definePlugin`-shaped default with `contributions: []`):

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  zLayerClass,
  type ZLayer,
  type InTreeLayer,
  type PortaledLayer,
} from "./internal/layers";

export default {
  description:
    "Semantic z-layer scale (z-base..z-max) and its enforcing lint rule (no-adhoc-zindex).",
  contributions: [],
} satisfies PluginDefinition;
```

> `z-layers` becomes the first "standard" plugin (alongside `radius`) to carry a
> web runtime. `./equin build` regenerates `web.generated.ts` from the
> filesystem — no hand-registration. `Z_LAYER_CLASS` stays internal; consumers
> use only the `zLayerClass()` resolver and the tier types.

### Consumer edits (delete local copies, import the resolver)

All four import from `@plugins/primitives/plugins/css/plugins/z-layers/web`.

1. **`css/overlay/web/internal/overlay.tsx`**
   - Delete the local `LAYER_CLASS` record and the `export type OverlayLayer`.
   - `import { type InTreeLayer, zLayerClass } from "…/z-layers/web"`.
   - `OverlayProps.layer?: InTreeLayer` (default stays `base`).
   - Root class: `cn("relative", zLayerClass(layer), className)`.
   - **API change:** `OverlayLayer` is no longer exported. Remove it from
     `overlay/web/index.ts`.

2. **`css/sticky/web/internal/sticky.tsx`**
   - Drop `import type { OverlayLayer } from "…/overlay/web"` and the local
     `LAYER_CLASS`; import `{ type InTreeLayer, zLayerClass }` from z-layers.
   - `stickyClasses` param + `StickyProps.layer` → `InTreeLayer`.
   - `className: \`sticky ${zLayerClass(opts.layer)}\``.

3. **`css/pin/web/internal/pin.tsx`**
   - Drop the overlay import + local `LAYER_CLASS`; import from z-layers.
   - `pinClasses` param + `PinProps.layer` → `InTreeLayer`.
   - `const classes = ["absolute", zLayerClass(opts.layer)]`.

4. **`css/viewport-overlay/web/internal/viewport-overlay.tsx`**
   - Delete the local `LAYER_CLASS` (popover/draw/max); keep the `OVERLAY_ROOT =
     "fixed inset-0"` module-const (that one dodges `no-adhoc-viewport-overlay`,
     unrelated to z).
   - `import { type PortaledLayer, zLayerClass }` from z-layers.
   - `ViewportOverlayProps.layer?: PortaledLayer` (default stays `popover`).
   - `className={cn(OVERLAY_ROOT, zLayerClass(layer), className)}`.

### Why this shape

- **One source, two tiers.** `Z_LAYER_CLASS` is the only name→class map; the
  `_Partition` type guard makes "added a layer but assigned it to no tier" a tsc
  error — the in-tree/portaled split can't drift from the ladder.
- **No cross-plugin re-export.** Today `sticky`/`pin` reach into `overlay` for
  the `OverlayLayer` type. After this, all four import the vocabulary from its
  real owner (`z-layers`) — `overlay` stops being an accidental hub. Honors the
  boundary rule (import the source barrel, never proxy).
- **Resolver, not exported map.** Consumers get `zLayerClass(layer)`; the record
  stays private so there's exactly one read site for the mapping.
- **Class strings unchanged** (`z-raised` etc.), so the existing pure-function
  tests (`sticky-classes.test.ts`, `pin-classes.test.ts`) pass untouched — they
  assert the produced class names and thereby validate the refactor.

## Critical files

| File | Change |
|---|---|
| `…/css/plugins/z-layers/web/internal/layers.ts` | **new** — ladder map, tier types, partition guard, `zLayerClass` |
| `…/css/plugins/z-layers/web/index.ts` | **new** — barrel re-export + `definePlugin` default |
| `…/css/plugins/z-layers/package.json` | no change needed (name already set) |
| `…/css/plugins/overlay/web/internal/overlay.tsx` | drop `OverlayLayer`+map; use `InTreeLayer`+`zLayerClass` |
| `…/css/plugins/overlay/web/index.ts` | stop exporting `OverlayLayer` |
| `…/css/plugins/sticky/web/internal/sticky.tsx` | drop map+overlay import; use `InTreeLayer`+`zLayerClass` |
| `…/css/plugins/pin/web/internal/pin.tsx` | drop map+overlay import; use `InTreeLayer`+`zLayerClass` |
| `…/css/plugins/viewport-overlay/web/internal/viewport-overlay.tsx` | drop map; use `PortaledLayer`+`zLayerClass` |

### Docs to update (hand-written prose; autogen blocks refresh on build)

- `z-layers/CLAUDE.md` — add a "Web barrel" section (the resolver + two tiers are
  the TS face of the ladder).
- `sticky/CLAUDE.md`, `overlay/CLAUDE.md`, `pin/CLAUDE.md` — remove the
  "copies the map locally because z-layers has no web barrel" prose; point at the
  shared resolver.
- `research/2026-06-20-css-primitives-audit.md` — mark §8.2 RESOLVED and reword
  §6's "three sets — mind the gap" (the gap now has one shared source).
- `docs/plugins-compact.md` / `docs/plugins-details.md` — regenerated by build.

## Verification

1. `./equin build` — regenerates the plugin registry + docs; fails loudly
   if the new web barrel is malformed or boundary/registry checks drift.
2. `./equin check` — must stay green. Specifically exercises:
   `type-check` (tier types + partition guard compile; the four consumers
   typecheck against the new prop types), `plugin-boundaries` (no cross-plugin
   `OverlayLayer` import remains; all four import the z-layers barrel),
   `plugins-registry-in-sync` + `plugins-doc-in-sync`, `eslint`
   (`no-adhoc-zindex` unaffected — named `z-*` still allowed).
3. `bun test plugins/primitives/plugins/css/plugins/sticky plugins/primitives/plugins/css/plugins/pin`
   — the pure-function class tests pass unchanged (class strings identical).
4. Smoke-render a sticky header, a pinned badge, an overlay, and a viewport
   overlay (e.g. the Layout Lab harness at Debug → Layout Lab, or any pane with a
   sticky header) at `http://att-1781987140-dzim.localhost:9000` — confirm
   stacking is visually identical (no z regression).
