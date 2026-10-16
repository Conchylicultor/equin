# inline-chip

Inline chips: a raw substring in text (`att-1787654245-y41m`, a
`<ui-context …>…</ui-context>` tag) that renders as a component — the same
component while composing in a `TextEditor` as on every read surface once sent.

Backend-free and domain-free on purpose: a module registry, one generic Lexical
node, a renderer and an error boundary. Anything that can load `text-editor` can
declare a chip, which is what lets a composition without `active-data` (the
equin website) still draw one. `active-data` builds on this — its markdown
enhancer, inline-text walker and page-editor bridge all read this registry — and
its chip sub-plugins (`attempt`, `conv`, `task-link`, …) declare here.

## One chip declaration, one registry, every surface

An inline chip is declared exactly once, and `inlineChip()` is the only thing
that can build one (`web/internal/inline-registry.ts`):

```ts
InlineChip.Tag(inlineChip({
  id: "ui-context",                       // names the chip in its error boundary + the docs
  pattern: UI_CONTEXT_RE,
  surfaces: ["transcript"],               // REQUIRED — no default
  modelText: "self-describing",
  component: UiContextTag,
}))
```

A chip for a declared id kind (`task-…`, `att-…`, `proto-…`, `block-…`) is not
hand-built: `active-data/id-chip`'s `idChip({ presenter, surfaces })` calls
this, with the pattern derived from the kind (`plugins/ids`).

`InlineChip.Tag` is the DECLARATION surface — it is what puts the chip in
`docs/plugins-details.md` and the reverse index — while `inlineChip` also
records the chip in a **module registry**. Both halves are sealed in one call,
and the contribution carries an unexported symbol brand: hand-writing
`InlineChip.Tag({ … })` is a tsc error.

**Why a module registry when the slot is already one.** Slot contributions are
readable only through a React hook (`bySlot` is built inside `PluginProvider`'s
`useMemo`), so every reader that is not a render — the Lexical hosts' headless
registries, the runs↔doc projection — cannot see them at all.

Three reads, and no way to get a raw `component` out:

| read | answers |
|---|---|
| `inlineChips(surface)` | the chips that declared this surface |
| `inlineChipExtension(surface)` | those chips' patterns as ONE token extension a Lexical host registers |
| `renderInlineChip(token)` | the chip that owns these characters, inside its boundary — or `null` |

All three read the registry at **call time**. Chips register progressively as
the plugin tiers load, so a snapshot taken too early silently under-reports and
its tokens render as plain characters with nothing failing.

`renderInlineChip` returning `null` for an unclaimed token is load-bearing, not
defensive: it is what lets a document holding a chip node still hydrate and read
correctly in a composition without the chip's own plugin.

**Inline patterns must be self-certifying.** Every pattern of a surface is
unioned into ONE Lexical node, so a "declined" token would still be a committed
node in the user's document with no host to catch it. There is no claim
protocol here; a token whose validity needs I/O is an `active-data`
`display:"code"` contribution instead.

### `surfaces` — where a chip belongs, declared by the chip

- **`"transcript"`** — text addressed to an agent: every `TextEditor` (a
  prompt, a task description, an Improve draft — the editor registry is global,
  so there is no finer grain), plus the markdown and user-text read surfaces
  that render those drafts and a conversation's messages.
- **`"document"`** — page content: the block editor and every read-only
  rendering of a page's runs.

Required, with no default, because this is how a chip that has no business in a
page stays out of Pages **without any consumer naming a contributor** — the host
asks for its own surface and gets exactly the chips that said yes.
`<ui-context>` is a pointer at a live UI element addressed to one agent turn;
`block-…` would compete with the page editor's own `[[page:<id>]]` token for the
same span. Both are transcript-only.

Two hosts ask: every `TextEditor` for `"transcript"` (this plugin's own
`register-node-source.ts`), the page editor for `"document"` (active-data's
`register-block-text-source.ts`). Each gets a different union from the same
declarations.

**Declaring `"document"` is a promise with a server half**, and
`./singularity check active-data:document-chip-has-server-token` collects on it.
A page block's content doc can now hold that chip's decorator node, and the
server REFUSES to read a block holding a decorator type it has no registered
node for (`block-text-write`'s `readStateRuns`) — so a chip with no
`Editor.InlineToken` contribution renders perfectly and then breaks an agent's
first `edit_page` on any block containing it, somewhere else entirely. The check
enumerates the chips and the server contributions generically and joins them on
the pattern source, so a fifth chip is covered the day it declares the surface.

### The editor half

`inlineChipExtension(surface)` unions every one of that surface's patterns into
a single generic node, which stores the raw matched substring, resolves its chip
at decorate time, and serializes back to that substring (so copy/paste and
markdown sync round-trip). Both hosts get it as a LOOKUP, not a list
(`registerNodeExtensionSource` / `registerBlockTextExtensionSource`), so the
union is recompiled per read rather than frozen at the moment the registering
plugin loaded. Declaring one chip lights the token up on **every** surface with
no per-chip Lexical wiring. (This is how the element-picker `<ui-context>` chip
is defined; it owns no Lexical node of its own.)

When the editor is editable, the node wraps the chip in `TokenFrame`
(`token-extension/node`) — selected as one object with a ring, and a
hover-revealed × removal affordance — every chip gets it for free, as do the
attachment nodes. Read surfaces render the chip through `renderInlineChip`,
never through the node, so they never get the ×.

**The node spec is `core/node.ts`, not the web file.** The browser's twin is
`inlineChipNode.decorated({…})` (exported as `inlineChipWebNode`, for a second
Lexical host to register), and each chip family's SERVER barrel contributes that
same `inlineChipNode` object to `page/editor`'s `Editor.InlineToken`. One
object, so the two runtimes cannot name a different type string, fields or token
format — which is what lets an agent read and `edit_page` a page block holding a
chip instead of being refused.

**Its Lexical type string is `"active-data-inline"`, and stays that way.** It is
persisted in every page doc holding a chip (the machinery was born in
`active-data`); renaming it would orphan those nodes. Only the TypeScript names
moved.

### An unsealed chip has no boundary, so it is given one back

Every other slot component reaches the screen through `slot-render`, whose
middleware wraps it in `PluginErrorBoundary`. An inline chip cannot: it is
spliced into a foreign ReactNode tree, so it is rendered straight from the
module registry and arrives naked — and nothing says so, because the chip
renders fine right up until one throws.

`renderInlineChip` therefore applies `<ChipBoundary>`
(`internal/chip-boundary.tsx`) INSIDE itself, which is what makes an
unboundaried chip unreachable: there is no way to get the component out. It
wraps the ELEMENT, never the component type — a wrapper minted per render
remounts the chip on every keypress. Without it, a chip that throws in the
editor is caught by Lexical's own boundary, whose stock fallback blanks the
entire content region into a red "An error was thrown." box, names no plugin,
and files no report.

The boundary is labelled with the chip's own `id`, not `_pluginId`:
`PluginProvider` stamps that onto a COPY of each contribution, and the object in
the module registry is the pre-copy original.

`renderInlineChip` also declares the chip's source text (`copiesAsText(token)`,
`primitives/dom/copy-source-text`) on a `display:contents` wrapper, because it
is the point where the token's characters stop being on screen — so copying a
rendered chip out of a read surface puts the token back on the clipboard.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Inline chips for every text surface: inlineChip() declares one (a self-certifying pattern, the surfaces it belongs on, and the component that renders it) and records it in a module registry; one generic Lexical node renders any declared chip, and inlineChipExtension(surface) hands a Lexical host that surface's chips as a single token extension. renderInlineChip(token) is the one rendering of a matched token, inside its own error boundary. Server-side referents of inline tokens: chip families contribute InlineTokenReferentSource (their chip's pattern + a resolve to the referent's title), and expandInlineTokenReferents rewrites a text's tokens as `<kind id title/>` so a model reads what the chip shows instead of an opaque id; inlineTokensAsText replaces them with the bare title, for text a person reads.
- Web:
  - Slots: `InlineChip.Tag`
  - Slot contributors:
    - `InlineChip.Tag` ← `active-data.attempt`
    - `InlineChip.Tag` ← `active-data.build-run`
    - `InlineChip.Tag` ← `active-data.conv`
    - `InlineChip.Tag` ← `active-data.event-source`
    - `InlineChip.Tag` ← `active-data.page-link`
    - `InlineChip.Tag` ← `active-data.prototype`
    - `InlineChip.Tag` ← `active-data.report`
    - `InlineChip.Tag` ← `active-data.song`
    - `InlineChip.Tag` ← `active-data.task-link`
    - `InlineChip.Tag` ← `primitives.ui-context.element-picker`
  - Uses:
    - `primitives/error-boundary.PluginErrorBoundary`
    - `primitives/text-editor.registerNodeExtensionSource`
    - `primitives/text-editor/token-extension/node.TokenFrame`
  - Exports (types):
    - `ChipModelText`
    - `ChipSurface`
    - `InlineChipContribution`
  - Exports (values):
    - `inlineChip`
    - `InlineChip`
    - `inlineChipExtension`
    - `inlineChips`
    - `inlineChipWebNode`
    - `renderInlineChip`
- Core:
  - Uses: `primitives/text-editor/token-extension/node.defineInlineTokenNode`
  - Exports (types): `InlineChipFields`
  - Exports (values): `inlineChipNode`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `active-data`
    - `active-data/id-chip`
    - `page/inline-page-link`
    - `page/links`
    - `primitives/ui-context/element-picker`
    - `tasks/task-title`
- Server:
  - Exports (types): `InlineTokenReferent`
  - Exports (values):
    - `expandInlineTokenReferents`
    - `InlineTokenReferentSource`
    - `inlineTokenReferentTables`
    - `inlineTokensAsText`

<!-- AUTOGENERATED:END -->
