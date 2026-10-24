# dom-scope

The DOM node that belongs to **one mounted instance**.

```ts
export const blockContentScope = defineDomScope<HTMLDivElement>({
  name: "page.block-content",
  what: "the block list's own content grid (published by <BlockEditor>)",
  bounds: ["data-block-id"],
});

<blockContentScope.Provider>      // common ancestor of owner and readers
  …
  <div ref={publishRef}>          // the OWNER: blockContentScope.usePublishRef()
  …
  const content = blockContentScope.useRoot();   // a READER, anywhere below
  content.attached ? blockRowIn(content.root, id) : null
</blockContentScope.Provider>
```

## Why it exists

The app mounts the same surface more than once at a time, on three axes: every
open tab stays mounted (`apps-core/tab-surface` hides the unfocused ones with
`display:none`, so a ⌘-click on any in-app link is enough), several floating
windows are visible at once, and miller columns show two panes of one app side by
side. `document.querySelector` returns the first match in DOM order — which may be
a hidden background tab's node, whose rects are all zero and which is not
hit-testable. Silent and total.

**When the asker owns the element, a plain ref settles it and this is not needed.**
This is for the reader that cannot: an overlay rendered BESIDE a scroller is not a
descendant of it, so it can neither ref the node nor walk up to it. The element has
to be published by a descendant and read by a sibling.

`useSurfaceTabId()` cannot key this — miller columns live inside one tab, so two
editors on `/pages/page/:a/page/:a` share a `tabId`. React tree position is the
only key that separates all three axes, which is what a `<Provider>` is.

## What it is made of

`install-sink`'s discipline with `scoped-store`'s lifetime. From `install-sink`:
`{ name, what }` so a missing host names itself; the rule that the only
render-path presence answer is a **subscription** (a callback ref fills one commit
after a reader's first render, exactly like a late install); and the `peek…`
naming, which hands `install-sink/no-render-phase-peek` the imperative sample for
free. From `scoped-store`: state per `<Provider>` mount, which is the entire
multi-instance fix — a module-level slot would have two mounted editors fighting
over one value.

## Three rules that look like details

- **The reader gets a union, never `HTMLElement | null`.** The unattached arm
  carries no `root` field, so `root?.querySelector(sel) ?? null` — the one-character
  collapse that cannot tell "not attached yet" from "no matching rows" — does not
  typecheck. A caller must write `attached ? … : …` and therefore must say what
  "not yet" means for its consumer.
- **No query helpers.** A `scope.queryAll(sel)` would have to answer something when
  unattached, and `[]`/`null` reintroduce exactly what the union removed. Domain
  helpers belong to whoever owns the DOM contract and take the root as a **required
  parameter** (`blockRowsIn(root)`, `blockRowIn(root, id)`) — the move commit
  `e31750f6b` made for `rowAtPointer`.
- **`usePublishRef()` hands back the callback ref itself, not an object carrying
  it.** A `.ref` property read in render is exactly what `react-hooks/refs` exists
  to catch and it cannot tell this one from a `useRef` handle, so the object shape
  made every owner an error at the one place the ref is supposed to go. An owner
  needing the imperative sample too takes `useScopeApi()` beside it.
- **A missing Provider throws, from both halves.** Rungs 1-3 are unavailable —
  "publisher and reader share a Provider" is a fact about a JSX tree assembled
  across three plugins. `scoped-store.useStoreApi` and `SurfaceOverlay` sit at the
  same rung. The publisher throwing is what makes it loud: the owner is usually
  always-mounted, so a host that forgets the Provider fails on every open with a
  message naming the scope, rather than a rail quietly not appearing.

The published ref also asserts on a **second** element published into one scope
(guarded by `isConnected`, so an ordinary reparent does not trip it) — a scope with
two roots has no defined answer and every reader is already wrong. A nested owner
wraps itself in its own `<Provider>`.

## `bounds` is the enforcement

A scope declares the attributes it bounds, and
`./equin check dom-scope:bounded-attr-not-document-wide` collects every
declared `bounds` in the tree and fails any `document.querySelector*` naming one.
**Declaring a scope closes the loophole for its own attributes, everywhere, with no
list for anyone to maintain.**

A blanket ban on `document.querySelector*` in web code is the wrong shape and was
rejected: of ~18 production call sites exactly one was a hazard, and the rest are
correct — boot mounts, `<head>` style and font management, and
`tab-drag-overlay`'s `[data-floating-window-id="…"]`, which is document-wide on
purpose because its selector pins a unique id. Safe-vs-unsafe turns on whether the
selector pins a unique id, which is not statically decidable, so such a rule needs
an allowlist of correct code — enforcing less than it looks.

## Related

- `scoped-store` — the parent, and the substrate. Per-instance **state**.
- `install-sink` — the deliberate opposite: one implementation for the whole page.
- `auto-scroll`'s `findScrollParent` — answers a different question ("the scroller
  I am inside"), by walking up. Not a substitute: a sibling cannot walk up to a
  node it is not inside.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The DOM node that belongs to ONE mounted instance: defineDomScope declares a scope a descendant publishes its element into and a sibling reads, so a lookup never reaches past its own instance into another mounted copy of the same surface. A scoped store holding one element — install-sink's discipline (named throws, subscription-only render reads, peek… naming) with scoped-store's per-Provider lifetime. Readers get a { attached } union, never a nullable root, so 'not mounted yet' cannot be absorbed into 'no matches'; the declared bounds derive the check that bans document-wide lookups of those attributes.
- Web:
  - Uses: `primitives/scope/scoped-store.defineScopedStore`
  - Exports (types):
    - `DomScopeApi`
    - `DomScopeHandle`
    - `DomScopeOptions`
    - `DomScopeRoot`
  - Exports (values): `defineDomScope`
- Cross-plugin:
  - Imported by:
    - `apps/file-explorer/browser`
    - `conversations/conversation-view/jsonl-viewer`
    - `page/editor`

<!-- AUTOGENERATED:END -->
