# Authoring reorder overrides

A reorderable slot's on-screen order must be a deliberate, committed layout — not the
non-deterministic natural order contributions happen to load in. So every reorderable slot
owes a **reviewed** override at `config/<defining-plugin>/<slotId>.jsonc`.

**The build produces the file; you decide the values.** `./equin build` seeds a
missing override from its generated `<slotId>.origin.jsonc` — real `// @hash`, the full
materialized catalog, the legend comments — and stamps a one-line `// @review` marker into
it. `config:overrides-authored` fails while that marker is present. Your job is the
judgment half only:

```
1. add the defineRenderSlot
2. ./equin build            → seeds config/<plugin>/<slotId>.jsonc, then fails on the marker
3. open the file: arrange "items", add rationale comments, DELETE the // @review line
4. ./equin check config:overrides-authored   → green (seconds)
```

You never copy an origin, never guess a path, and never transcribe a hash. A mistyped path
used to get the file silently pruned; a mistyped hash used to cost another build. Neither is
reachable now — the file is machine-produced at the right path with the right hash.

## Arranging `items`

Node forms:

- `"pluginId:id"` — a contribution, by entryKey (the terse form of `{ "item": … }`).
- `{ "item": "pluginId:id", "hidden": true }` — remove it from the slot.
- `{ "type": "spacer", "id": "<unique-id>" }` — a blank gap. **At most one per slot.**
- `{ "type": "header", "label": "…", "collapsed": false, "items": [ … ] }` — a labeled,
  collapsible container (one level, no nesting).

Order for the slot's actual layout — a sidebar, a toolbar, a pane section each read
differently (vertical list vs. horizontal bar vs. stacked blocks). Look at how the slot
renders and order for that context. Leave a comment saying *why* the order is what it is;
that rationale is the only thing in the file a machine could not have written.

## When the catalog shifts under a committed override

Adding or removing a contribution changes the slot's materialized catalog, which changes
the origin's hash. The same build pass **re-marks and re-stamps** the override: it writes
the fresh `// @hash` for you and re-inserts `// @review`, with the delta (`+foo:bar`,
`-baz:qux`) named in the marker line.

So a stale hash is no longer "acknowledged" by retyping it. Retyping was never review — the
new contribution would still be missing from `items`, and `applyTree` would append it at
the end in natural order, landing an unreviewed default. Now the one gate is the same as at
creation: **place the new entries deliberately, then delete the marker line.**

## If the slot should never be user-curated

It is headless: declare it with `defineMountSlot` instead of `defineRenderSlot`. Mount slots
render nothing, so order is meaningless — they are absent from the reorder manifest and owe
no override.
