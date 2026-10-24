# passthrough

## The promise

Most primitives here accept props they do not name. You spread a `data-*` you
use as a selector target, an `id`, a `title`, a `style`, a drag handler — and
the primitive puts them on the element it renders. That saves it from
enumerating every attribute anybody might ever want, and it is worth keeping.

It is also a promise, and this plugin is that promise written down:

> everything you spread lands on **one node**, and it is the same node
> tomorrow.

`ref` is the other half of it. `ref` **names** the node; the bag **addresses**
it. Which is why the two are declared together, in one marker type:

```ts
export interface BadgeProps extends Passthrough {
  variant?: BadgeVariant;
  children: React.ReactNode;
}
```

A primitive can no longer be open about its props while staying silent about
which element they reach — `extends Passthrough`
(`@plugins/primitives/plugins/passthrough/core`) brings the node with it. Pass
the element type when the ref is narrower than `HTMLElement`
(`extends Passthrough<HTMLDivElement>`): a mutable ref is invariant, so
`Ref<HTMLDivElement>` is not assignable to `Ref<HTMLElement>` and the bare form
would be a type error.

Extending the marker adds the **type**, not the plumbing. React 19 treats `ref`
as an ordinary prop, so a primitive that never destructures it — `Badge`,
`ToggleChip`, `SurfaceOverlay`, the tab-bar variants — has been forwarding it
correctly all along through the single `{...rest}` it already writes, untyped
and undocumented.

## "Render one element" is the wrong measure

The obvious rule is that a primitive with an open passthrough must render a
single element. It is wrong in both directions, and it is worth being precise
about why, because the wrong version is the one people reach for.

`Badge` renders a chip wrapping a truncating label — two elements — and is
correct. `OverlayPanel` renders a panel with a sticky header inside it and is
correct. `Row` rendered exactly one element and was **wrong**: it spread the bag
on "the rendered element", which was one element right up until a caller passed
`actions`, and from that moment on was a container box wrapping a synthesized
`<button>`. So a `data-*` attribute somebody used as a selector target moved
from the row box to a button. At a call site nobody edited. With no throw, no
type error and no failing test.

What went wrong was never the element count. It was that the bag's destination
was never *stated*, so it could move without anyone noticing it had. That has
now been fixed in `Row` three times — refs, focus styling, and the passthrough —
each time after the bug was found in the wild.

## Growth: one case is harmless, one is the bug

Once the bag is anchored to `ref`, adding chrome sorts itself into two cases.

Wrapping the anchor in a new outer element is **fine**:

```tsx
<div className="frame">
  <div ref={ref} {...rest} />   {/* the caller's node is still the caller's node */}
</div>
```

Moving `ref` to the new wrapper and leaving the bag on the inner element is
**the bug**:

```tsx
<div ref={ref}>
  <span {...rest} />            {/* the attributes and the node are now two elements */}
</div>
```

The second shape is what `passthrough/no-unanchored-passthrough` rejects.
`ViewportOverlay` had a live instance of the same defect from the other side: it
wrote `ref={rootRef}` *after* `{...rest}`, so a caller's ref was silently
discarded by its own internal one. Composing the two through a `useCallback`
(the shape `OverlayPanel` uses) is the fix.

## When a second destination is real

Some primitives genuinely have two nodes, and the attributes really do belong to
different ones. `Row` synthesizes its own `<button>`/`<a>`, and everything that
describes *that control* — `onClick`, `href`, `role`, `tabIndex`, every
`aria-*` — has to reach it rather than the row box: a `disabled` button must
swallow its own `onClick`, and `aria-expanded` describes the disclosure control,
not the strip around it.

That split is allowed. What is not allowed is doing it anonymously. Say it by
name:

```ts
const { anchored: boxProps, routed: controlProps } = splitPassthrough(rest, isControlKey);
```

`anchored` is the half that keeps the promise and must land on the `ref`
element. `routed` is the half you are declaring goes somewhere else — and
naming it *is* that declaration, which is the entire difference between a routed
passthrough and the `Row` bug. The predicate stays with the primitive, because
it is the primitive's own vocabulary (`Row` routes every `aria-*` by prefix, an
open family that a key list could never finish enumerating).

A hand-rolled `Object.entries(rest)` loop does the same work and states nothing.
That is how `Row` used to route, and it is why `splitPassthrough` exists as a
named call rather than a paragraph of advice.

## What the two lint rules reject

**`passthrough/no-anonymous-passthrough`** — an index signature written inline
in a props type:

```ts
interface RowProps {
  children: React.ReactNode;
  [key: string]: unknown;    // ← rejected: spell it `extends Passthrough`
}
```

This is the gate. Without it a new primitive could open a bag, expose no node at
all, and there would be nothing for the second rule to check the bag against.
It fires only on declarations whose name ends in `Props`, which leaves the
repo's open *data* records alone — the durable event payloads
(`ConversationTurnCompletedPayload`, `RefAdvancedPayload`, …) and the plugin
`Contribution` types are bags nothing spreads onto an element. The `Passthrough`
marker is exempt by the same construction, so there is no path allowlist
anywhere.

**`passthrough/no-unanchored-passthrough`** — how the rest binding is used
inside a component whose props type is open. It finds its subjects through the
type checker rather than by matching `extends Passthrough` in the file, so a
props type declared in one plugin and implemented in three others (`TabProps`)
is still seen. It rejects four things:

| | |
| --- | --- |
| `restEscaped` | the bag used anywhere other than a JSX spread, `splitPassthrough(rest, …)`, or a read of one named key (`rest.role`) — so `Object.entries(rest)`, `const props = {...rest}`, `helper(rest)` |
| `restFannedOut` | the same bag spread onto more than one element that can render alongside it |
| `restOffRef` | the bag spread onto an element carrying no `ref`, while the component destructures `ref` |
| `anchoredOffRef` | `splitPassthrough`'s `anchored` half spread off the `ref` element, or spread more than once |

Two elements that can never render together are not a fan-out. `Row` returns
one tree for the plain row and another for the row with actions, spreading the
same bag on each — that is one destination written twice, and the rule reads
different `return`s (and opposite arms of an `if` / ternary / `switch`) as
exactly that.

Two things it deliberately does not do. It checks that a `ref` attribute is
**present** on the receiving element, never what its expression is — a composed
callback ref merging the caller's with internal ones is correct, and no
syntactic test can tell that from a wrong one. And when a component does **not**
destructure `ref`, nothing is checked: the ref rides inside the bag and lands
wherever the bag lands, which is why `Badge` is correct as written.

The residual hole, stated so nobody assumes otherwise: a bag spread onto a
*component* that renders no DOM node is swallowed silently, and no rule reading
one file can see it. `trigger-render-safety/no-provider-trigger-render` covers
the closest instance of that class.

A genuine one-off escapes per site, with its reason next to the code:
`// eslint-disable-next-line passthrough/<rule> -- <reason>`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The open-passthrough contract: a primitive that accepts props it does not name promises they land on ONE node, and `ref` is that node's name. Owns the Passthrough props marker, the splitPassthrough router for the rare second destination, and the two lint rules that keep the promise true.
- Core:
  - Exports (types): `Passthrough`
  - Exports (values): `splitPassthrough`

<!-- AUTOGENERATED:END -->
