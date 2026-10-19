# token-extension

The one declaration of an **inline token** — a decorator node that persists as
TEXT (`[[page:<id>]]`, `[[date:<iso>]]`, `\(latex\)`,
`![alt](/api/attachments/<id>)`, a bare `att-…` id).

## THIS PLUGIN MUST NEVER IMPORT `lexical` AS A VALUE

Read this before adding an export here, and before "tidying" the `node`
sub-plugin back into its parent.

`@plugins/page/plugins/editor/server` imports `tokenExtension` from this barrel.
drizzle-kit loads every schema-glob file (`server/**/internal/{tables,schema}.ts`)
with a SYNCHRONOUS `require()` when it generates migrations, and several page
schema files reach that editor barrel. `lexical` has a top-level-`await` module
in its graph, so it cannot be required synchronously: one runtime edge from here
to `lexical` makes ~9 schema files unloadable, and drizzle-kit then exits 0 with
those tables **silently missing** from migration generation. (The
`schema-files-loadable` check is what turns that silence into a build failure.)

So the plugin is split by loadability, not by feature:

| here (`token-extension`) | `plugins/node` |
| --- | --- |
| every declaration TYPE (`InlineTokenNode`, `InlineTokenNodeRef`, `InlineTokenNodeSpec`, `InlineTokenDecoration`, `TokenFields`) | `defineInlineTokenNode` — the `DecoratorNode` subclass factory |
| `tokenExtension` — pattern ⨯ node | `$insertTokenizedText` / `$tokenizedLineNodes` |
| `matchTokens` / `hasToken` / `CODE_MARK` — THE line scan | `TokenPastePlugin` |
| `createSourcedRegistry` | |

`import type { … } from "lexical"` is fine here and is what the type half uses:
type imports emit nothing. A **value** import — `DecoratorNode`,
`$createTextNode`, `$getSelection`, any `$…` function — belongs in `plugins/node`.

Two consequences worth stating plainly:

- **Nothing in this plugin may import `plugins/node`.** The dependency runs one
  way (`node` → parent), which is also what keeps the two out of an import
  cycle. That is why `token-scan.test.ts` lives in `plugins/node`: it needs real
  token families, and a real family can only come from `defineInlineTokenNode`.
- **Never re-export `plugins/node`'s values from this barrel.** It would look
  like a convenience and would restore the runtime `lexical` edge — which fails
  loudly at `./singularity build` (good) but is exactly the mistake this table
  exists to prevent. It is also forbidden outright by the no-cross-plugin-re-export
  boundary rule.

## One declaration, everything else derived

A family declares only what is irreducible:

```ts
defineInlineTokenNode({ type, fields, token, fieldsOf, textContent })
```

and gets back a descriptor carrying the Lexical class, `create` / `is` /
`token` / `fieldsOf` / `setFields`, and `decorated({ className, render })` for
the browser half. `tokenExtension({ id, pattern, node })` then derives
`createNodeFromMatch` and `serializeNode` from that same descriptor.

`getTextContent`, `exportJSON`/`importJSON` and `exportDOM`/`importDOM` are
derived from it too — every way a token leaves an editor, from the one place
that knows what it is made of.

**The stub hazard is unspellable.** There is no way to obtain a node class for
this system except through `defineInlineTokenNode`, which REQUIRES `token`;
every extension's serializer derives from that same `token`. A class that
hydrates successfully and serializes to `""` — silently deleting the token, the
failure `page/block-text-write/server/internal/block-doc-text.ts` warns about —
cannot be written.

**`exportDOM`/`importDOM` are not optional decoration** — see
`plugins/node/core/token-dom.ts` before touching them. A decorator's content
comes from `decorate()`, which HTML serialization never calls, so the inherited
default exports an empty `<span>`. And the HTML arm is the ORDINARY paste path
between two page blocks, not an edge case: Lexical takes its own
`application/x-lexical-editor` payload only when the namespaces match, and every
block is its own editor (`block-text-<blockId>`).

The descriptor also carries a brand whose symbol is never exported, so an
`InlineTokenNode` cannot be written as an object literal. `brandInlineTokenNode`
is the one seam through it, and it exists for exactly one caller —
`defineInlineTokenNode`, which the split above put in another plugin.

## Why `fields` is a list of NAMES

`@lexical/yjs` decides which properties it will ever sync ONCE, at binding
setup: `initializeNodeProperties` constructs `new klass()` **with no arguments**
and snapshots `Object.entries(node)`. Hydration then does `new Klass()` and
copies the `Y.XmlElement`'s attributes back on as `__`-prefixed own properties.
So each field is a separate string attribute, and the synthesized constructor
seeds every `__<field>` with `""` and takes only an optional `key`. A field a
constructor sets lazily is a field that silently never crosses the CRDT.

Declare a family's field record as a **`type` alias** of an object literal,
never an `interface`: TypeScript grants an implicit index signature only to the
former, and without it `YourFields` does not satisfy the `F extends TokenFields`
constraint — `defineInlineTokenNode<YourFields>` is rejected outright.

## Two descriptor types: the ref and the handle

`defineInlineTokenNode` returns an `InlineTokenNode<F>`, which **extends** the
field-erased `InlineTokenNodeRef`. A registry (`registerNodeExtension`,
`registerBlockTextExtension`, `InlineTokenExtension`) stores the **ref**; the
plugin that declared the family keeps the **handle**.

That split is what makes the erasure a real subtype relation instead of a cast.
A registry is a homogeneous list, so it names one type for every family. Naming
`InlineTokenNode<TokenFields>` cannot work: `F` sits in consumer positions on
the handle (`create(fields: F)`, `tokenOf`, `setFields`) and `keyof F` appears
in `fields`, which makes the generic **invariant** — so
`InlineTokenNode<PageLinkFields>` is related to `InlineTokenNode<TokenFields>`
in neither direction and every registration site is a type error.

The ref therefore never mentions `F` at all. Everything a registry needs — name
it, register its class, ask "is this node yours?", serialize one of its nodes,
build one from a regex match — is expressible without accepting an `F` from the
caller: the erased builder is `createFromMatch(match)`, which runs the family's
own `fieldsOf`, so the only field record a family ever receives is one it wrote
itself.

## Two runtimes, one class hierarchy

`defineInlineTokenNode` mints a HEADLESS class: `decorate()` returns null and
`createDOM()` throws. A browser host calls `.decorated({ className, render })`
for a twin descriptor over a SUBCLASS that adds only rendering. Same type
string, same fields, same token format, because they come from the same
declaration.

**Never register both in one editor.** Lexical keys its node registry by type
string and rejects a second class for the same one.

## `matchTokens` is THE line scan

It replaced three hand-rolled copies that had already drifted (one sorted and
dropped overlaps, one raced two regexes, none looked at marks). Semantics:

- a run carrying the **`code`** mark yields NOTHING — `` `att-…` `` written as
  inline code is documentation, not a widget;
- a fresh `/g` regex per extension per call (a `pattern` may carry `/g`, whose
  `lastIndex` is stateful);
- a match whose `fieldsOf` returns `null` is not a token, so it neither appears
  nor consumes the span;
- sorted by start, and a match beginning inside an already-taken span is
  dropped — first-by-position wins.

It stays on this side of the split deliberately: the scan is pure string work,
and a read-only renderer that paints a token without Lexical must be able to
reach it.

It is also GENERIC in the extension it walks (`TokenScanExtension`: a `pattern`,
and a `node` that reads a match back into fields — nothing else). A host's own
registry entry is usually WIDER than an `InlineTokenExtension`: the page editor's
`BlockTextExtension` carries the read-only renderer alongside the Lexical halves.
Keeping the caller's type on `TokenMatch.extension` is what lets that consumer
render straight off a match instead of joining back to its registry by `id` —
a string key nothing checks.

## `createSourcedRegistry` — a host registry that folds in LAZY sources

Every Lexical host keeps a registry of the token families it knows about
(`registerNodeExtension` in the prompt editor, `registerBlockTextExtension` in
the page editor). Both need a second kind of entry: not an item, but a FUNCTION
that produces items when asked.

A plugin whose token set is itself a registry (`inline-chip`'s chips)
cannot hand over a finished list at module eval — the chips fill in as the
plugin tiers load, so a snapshot taken by whoever evaluated first silently
under-reports and those tokens render as plain characters forever. Registering
the LOOKUP moves the read to the moment the answer is used.

It lives here rather than in either host because two copies would be two
statements of the call-time rule, and that rule — never memoize `all()` — is the
whole content of the module. This is the one plugin both hosts already import
for exactly this contract. Generic in the item, because the two hosts store
different payloads (`InlineTokenExtension` vs `BlockTextExtension`); what they
share is the entry model.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The inline-token primitive's synchronously-loadable half: the declaration TYPES of a token family, the tokenExtension pairing of pattern and node, THE line scan, and the lazy-source host registry. Imports lexical for types only — the class factory lives in the `node` sub-plugin.
- Cross-plugin:
  - Imported by:
    - `page/editor`
    - `primitives/text-editor/token-extension/node`
- Core:
  - Exports (types):
    - `InlineTokenDecoration`
    - `InlineTokenExtension`
    - `InlineTokenNode`
    - `InlineTokenNodeRef`
    - `InlineTokenNodeSpec`
    - `SourcedRegistry`
    - `TokenFields`
    - `TokenFieldValue`
    - `TokenMatch`
    - `TokenScanExtension`
    - `UnbrandedInlineTokenNode`
  - Exports (values):
    - `brandInlineTokenNode`
    - `CODE_MARK`
    - `createSourcedRegistry`
    - `hasToken`
    - `matchTokens`
    - `tokenExtension`
- Sub-plugins:
  - **`node`** — The inline-token node factory's browser half: TokenPastePlugin, the registry-driven paste that materializes a pasted token as its node and declines an intra-app copy (which already carries the…

<!-- AUTOGENERATED:END -->
