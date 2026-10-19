# Theme

Global base styles and the Tailwind token layer. Token **values** (`--background`,
`--primary`, etc.) are **not** declared here — they are owned solely by the
token-group descriptors (`defineTokenGroup`) and emitted at runtime by
`ThemeInjector` (one `<style id="theme-engine-<group>">` per group). `app.css`
holds only non-token base styles: the `@theme` Tailwind tokens, the `@theme
inline` bridges (which map `--color-*`/`--text-*`/`--radius-*`/`--shadow-*`
utility tokens onto the runtime vars), the structural `--z-*` ladder,
`color-scheme` on `:root`/`.dark`, the `@utility` definitions, and `@layer base`.

**Never read a bridge copy as a value** (`var(--color-x)`) outside `@theme` — in
a `@utility`, a rule, or a class string. The bridge property lives on `:root`,
where its `var()` is substituted once, so a scoped app theme
(`[data-theme-scope]`) is ignored and the desktop colour paints. Read the
runtime var (`var(--x)`); Tailwind's own utilities already do. Enforced by the
`theme-bridge-reads` check.

The first painted frame is themed by the server, not by `ThemeInjector` (which
only runs after React mounts + a config round-trip), and no browser storage is
involved:

- **Every load:** the backend renders the theme CSS of every app path
  (`theme-engine/server`, through `shell/document-head`'s `DocumentHead.Fragment`)
  into `document-head.json`; the gateway splices the entry matching the requested
  path into `index.html` before `</head>` as `<style id="theme-engine-*">` /
  `theme-scope-*` elements plus a one-line `.dark` script (the *configured* mode,
  so `"system"` resolves against the live OS scheme). `ThemeInjector` then adopts
  those same elements by id — one renderer in `theme-engine/core` (`paint.ts`)
  serves both, so there is no flash and no duplicate styles.
- **No fragment (a backend that has never booted):** the inline script in
  `index.html` only sets `.dark` from the OS preference and the page shows the
  neutral `html { background: Canvas }` loading floor below; `ThemeInjector` fills
  real values on mount.

No static token values are reintroduced — the token group remains the single
owner of every `--token`.

## Rules

- **No plugin-specific CSS here.** Animations, keyframes, component overrides, and structural styles belong in the plugin that uses them (as a `.css` file imported from the plugin's own code).
- **Plugins consume tokens, never define them.** Plugin CSS files may reference `var(--background)` etc. but must not set `--background:` or any other theme variable. This rule is now **machine-enforced** by the `css-vars-single-owner` check: every token-group var must have exactly one declaring owner (its token group), so re-declaring one in static CSS — here or in any plugin — fails the build (declarations inside `@theme`/`@theme inline` are excluded, being Tailwind's lower-precedence utility layer).
- **No plugin-level theming.** Themes are controlled globally. Plugins must not define their own theme overrides, color schemes, or mode-specific (`.dark`) custom property blocks. If a plugin needs a new token, add it to the relevant token group's descriptor.

## Publish your own role: a container names what a descendant must adapt to

One contract, stated once: **a container publishes as a CSS variable any private
decision a descendant has to adapt to.** A class name carries no value, so
without this a child has nothing to read and every consumer ends up
re-hardcoding the container's choice. There are two families.

**Colour roles** — derived helpers, not token-group tokens: they hold no value
of their own, they *follow the surface* a component was dropped into. Every
surface co-publishes both — see the `:root, [data-theme-scope]` defaults here,
`SURFACE_LEVELS` (per elevation role), and the app-shell sidebar wrapper.

| var | utility | means |
|---|---|---|
| `--chrome-mask` | `bg-chrome-mask` | *my background*, for a sticky bar painting **over** me |
| `--hover-fill` | `bg-hover-fill` | *a visible step off my background*, for a control highlighting **inside** me |

**Geometry roles** — the rail: where the things inside me start. Published by
the `rail-*` utilities in `app.css` (see the RAIL section there, and
[`primitives/css/rail`](../../../rail/CLAUDE.md) for the model).

| var | published by | means |
|---|---|---|
| `--rail-start` / `--rail-end` | `rail-<step>`, `rail-x-`, `rail-owe-` | the inline inset **already applied** between a child's content and my edge |
| `--rail-owed-start` / `--rail-owed-end` | same three | the inline inset a follower must **still apply itself** — `0` from the paying classes, the step from `rail-owe-` |
| `--rail-block-start` / `--rail-block-end` | `rail-<step>`, `rail-y-` | *my block padding*, per edge |

**`--rail-start` is what a bleeder cancels; `--rail-owed-*` is what a follower
still pays.** They are two questions, and one number cannot answer both: in the
inverted topology (data-view — the bands inset themselves, the container does
not) a container that pads *and* publishes a non-zero rail is telling every band
inside it to pay again, which doubles the inset. `rail-follow` reads owed → rail
→ chrome pad; `rail-bleed` reads only the applied pair, which is what makes it
land on the region edge under either topology.

The block pair exists for `scroll-fade`'s sticky edge strips: a sticky inset
resolves against the **content** box, so a strip at `top: 0` parks the host's
block padding short of the visible inner edge and scrolled content re-emerges
unfaded in the last few pixels. The strip has to know a length the padding class
alone cannot tell it. Per edge, not one shared number — a host with asymmetric
block padding would otherwise have one of its two strips silently wrong.

Unlike the colour pair, the rail vars have **no `:root` default**, and must not
gain one: every read carries its own fallback (`var(--rail-start, 0px)`, or the
chrome pad for `rail-follow`), and a `0px` default would make all of them dead
code — every pane would go flush. "Nobody opened a region here" must stay
distinguishable from "someone opened one of width zero".

`--hover-fill` exists because a **transparent** control has no surface of its own:
`Button variant="ghost"` used to hover to the fixed `bg-muted`, which is
calibrated against the page canvas (`--background`). Dropped in a sidebar, where
`--sidebar` (0.965) and `--muted` (0.97) are the same tone, the hover painted the
surface color onto itself and read as *no hover at all* — while the
`SidebarMenuButton` beside it (correctly hovering to `--sidebar-accent`) lit up,
so one row highlighted in two different ways. Following `--hover-fill` makes the
two identical **by construction** rather than by matching hardcoded classes.

Consequences when adding a **colour** role (the rail is per-region by
construction, so none of these apply to it):

- **Publish both together.** A new tinted surface that sets a background and
  neither var inherits the *enclosing* surface's — the hover/mask silently
  belongs to the wrong plane.
- **Re-declare at the scope root.** Both are custom properties, and
  custom-property inheritance passes the **computed** value: anchored on `:root`
  alone, a forked app's `[data-theme-scope]` subtree inherits the desktop
  preset's resolved color and ignores its own. Hence `:root, [data-theme-scope]`.
  The `inherited-theme-defaults-scoped` check enforces this.
- **Only transparent variants follow the surface.** `default`/`outline`/
  `secondary`/`destructive` paint their own background, so their hover is
  relative to *themselves* and correctly stays a fixed token.

## Menu rows: `menu-row` / `menu-row-lit`

The state layer of the shared menu row (the class lists are `menu-row.ts`
beside this file; ui-kit's CLAUDE.md has the full contract). `menu-row-lit` is
only ever applied under a state variant (`data-highlighted:`, `data-popup-open:`,
`hover:`), which is how three state models share one paint without this file
naming any of their DOM.

## Adding a custom `@utility` (the twMerge marker)

`app.css` is the **single source of truth** for every custom `@utility` AND for how
`cn()`/tailwind-merge must classify it. The registry consumed by `cn()`
(`custom-utilities.generated.ts`) is **generated** from co-located markers by
`./singularity build` — there is no array to edit anywhere, and membership can't
drift.

Every `@utility` MUST carry one co-located `/* twmerge: <ref> */` marker (the
generator throws, with the offending `@utility` named, if any is missing — an
immediate codegen-step build error, not a silent post-build check miss). `<ref>`:

- `extend <builtin>` — append the class into an existing built-in tailwind-merge
  group (single-property utilities whose property maps 1:1 to one group). Gives
  order-independent mutual conflict and lifts the class out of any wrong fallback
  group (e.g. a `text-*` role out of text-color). Allowed `<builtin>` ids:
  `font-size font-weight z h w size min-h p px py pt pr pb pl gap gap-x gap-y rounded border-w-b`.
- `<sg-id>` — a synthetic group id, for multi-property utilities (e.g. `h`+`w`) or a
  property covered by several built-in groups (`height` → both `h` and `size`).
  Declare the group **once** in the section-header comment as
  `/* @twmerge group <sg-id> excludes: <builtin…> */`; each member just references
  the id.
- `standalone -- <reason>` — intentionally outside twMerge; the reason is required.

Examples (all real, from `app.css`):

```css
/* Density padding utilities … @twmerge group sg-pad excludes: p */
@utility p-card    { padding: var(--pad-card); }                /* twmerge: sg-pad */
@utility p-sm      { padding: var(--space-sm); }                /* twmerge: extend p */
@utility focus-ring { … /* twmerge: standalone -- Additive box-shadow/outline; no single-value built-in group to conflict with. */ }
```

### What a group declares

`excludes:` is **mutual** — whichever class comes last survives, in either order.

**List only what must be mutually exclusive.** `lib/utils.ts` closes the list over
tailwind-merge's own map both ways, so naming `p` also beats `px`/`pt`/`ps`/… and
naming `h` also submits to `size`. Over-listing is how you delete a neighbour's
real padding.

**But a utility that PUBLISHES what it applies must also name the per-edge
groups** — closure widens up and down, never sideways into a narrower neighbour,
so without `pt` a later `pt-2` sits beside `rail-lg` and `--rail-block-start`
advertises a number `padding-top` no longer applies. Hence
`sg-rail excludes: p px py pt pr pb pl`, while non-publishing `sg-pad` stays at
`excludes: p` so `p-card px-2` can legitimately keep both.

`under: <builtin…> -- <reason>` is the one-directional escape (the built-in is
strictly broader: it removes the group, the group must not remove it). Reason
required. Nothing needs one today — closure covers every current case — so use it
only when you can write down why.

The marker may sit at end-of-line, on the line below, or inside the rule body — the
generator slices from each `@utility` to the next and reads the first
`/* twmerge: … */` in that slice. After editing, run `./singularity build`; the
`app-css-utilities-in-sync` check guards the regenerated file.
