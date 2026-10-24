# An artifact's address must cover everything its bytes inline

_2026-08-17 — web-artifacts content-addressing_

## The outage

`./equin build` failed at compose with

```
compose: 1 staged import(s) do not link — "@plugins/reorder/web" does not export
"useEditMode" (imported by artifacts/primitives.adaptive-bar.fixtures.…)
```

for an import no source file in the repo produced. `useEditMode` had been moved
out of `reorder/web` an hour earlier and every source site updated;
`type-check` and `plugin-boundaries` both passed. Deleting that one store entry
by hand unblocked the build.

## The mechanism

The store is content-addressed: an artifact's dir name is
`<slug>.<kind>.<inputsHash16>`, and `inputsHash = H(kind, ownHash,
builderIdentity)` where `ownHash` covers the plugin's **own files**. If the
artifact already exists at that address, the build reuses it untouched.

That is only sound if the address covers *everything whose content enters the
bytes*. Two independent, hand-maintained tables decided the two halves, and
they disagreed:

| | who decides | for kind `fixtures` |
|---|---|---|
| **content** (what rollup inlines) | `core/externals.ts` — every own-path specifier except own-`core` and own sub-plugins is inlined | `fixtures/` **+ `web/` + `shared/`** |
| **address** (what is hashed) | `core/internal/own-files.ts` — `web`→`web`+`shared`+`core`; every other folder-barrel kind → that one folder | `fixtures/` only |

So `primitives/adaptive-bar/fixtures` **inlines a whole private copy of
`adaptive-bar/web`** — the store artifact externalises `adaptive-bar/core` and
carries `web/`'s own dependencies (`useEditMode`, `ViewportOverlay`,
`OverlayPanel`) as *its* externals — while its address ignores `web/` entirely.
Change `web/`, leave `fixtures/` alone, and the store answers "unchanged" and
serves a bundle built against hour-old sibling code.

Here it failed loudly only because an export vanished and compose's
link-verification caught the fossilised import. The same staleness serves
subtly-wrong **behaviour** whenever the stale bundle still links — nothing
reports that.

It is not one plugin's problem. Two more live instances:

- `css/plugins/text/fixtures` imports its own `…/text/web` — same shape,
  and has simply never had `web/` change without `fixtures/` changing too.
- Both `prewarm` barrels (`sonata/audio/{piano,soundfont}`) import
  `../shared/mirror` — the remote asset base URL. `prewarm`'s address covers
  `prewarm/` only, so editing `shared/mirror.ts` leaves the release runner
  baking assets from the *old* base, silently.

There is a second, separate defect hiding in the same table: because the
fixtures bundle inlines its own plugin's `web/`, the Layout Lab runs **two
instances** of that plugin's web module — the artifact the app loaded and the
private copy inside the fixtures bundle. That is exactly the "one URL = one
module instance" invariant the own-`core` externalisation already exists to
protect, applied to only one of the folders that needs it.

## The fix

### Rung 1 — one list, so the two halves cannot disagree

New `core/own-roots.ts` holds the single definition:

```ts
/** The plugin-relative folders an artifact of `kind` INLINES. */
export function inlinedRootsFor(kind: ArtifactKind): readonly string[] {
  return [kind, "shared"];
}
```

`shared/` is in every kind's set by design: it is plugin-private DRY with no
barrel (most `shared/` dirs have no `index.ts`), deliberately duplicated per
consuming runtime. Everything else in the plugin's own tree is **external** —
routed to that folder's own barrel artifact, which the import map already
serves.

Both halves now derive from that one list:

- `internal/own-files.ts` — `listOwnFiles` walks `inlinedRootsFor(kind)`.
- `core/externals.ts` — `makeArtifactExternal(ownPluginPath, kind)`: an
  own-path specifier is inlined iff its first segment is an inlined root.
- `internal/vite-builder.ts` — `ownCoreBarrelPlugin` generalises to
  `ownFolderBarrelPlugin`: any resolved id landing in an own folder outside the
  inlined set is rewritten to `@plugins/<own>/<folder>` and externalised
  (missing barrel ⇒ hard error). The old special case (own-`core` from `web`)
  is one instance of the general rule.

Net source changes across the repo: `fixtures` → own `web` becomes an
import-map edge in two plugins. Nothing else in the tree crosses a folder
boundary today.

The `web` hash also **narrows** — `core/` leaves it, correctly: `web` never
inlines own-core (it is rewritten to the external barrel), so hashing it only
forced spurious rebuilds. A core-only change no longer rebuilds the plugin's
web artifact.

### Rung 4 — an assert that does not trust either half

`internal/inline-audit.ts` is a vite plugin + verifier. `generateBundle` reads
each emitted chunk's `modules` keys — the module ids rollup *actually* included,
post-tree-shaking — and after the build every first-party id (absolute, not
`\0`-virtual, not under `node_modules/`) must lie inside the artifact's hashed
roots. Anything else fails the build naming the files.

This is what makes the class structurally dead rather than merely fixed once: it
is independent of the roots list *and* of the externals predicate, so a future
vite plugin, alias, or new folder kind that inlines unhashed content fails
immediately instead of fossilising.

_Update 2026-09-23:_ "inside the hashed roots" became "a file the address
hashed" (`isHashedFile`). The hashing walk skips test code (`testing/`,
`__tests__/`, `*.test.ts`) that sits inside a root, so bare containment let a
bundled test helper through unhashed. The audit now reads the walk's own skip
rules. See `research/2026-09-23-global-testing-folder-tool-audit.md`.

Reused artifacts are not re-audited, and do not need to be: the builder's own
source digest is part of the builder identity, so editing this plugin
invalidates the whole fleet once and every artifact is rebuilt — and audited —
under the new identity.

### Fallout: a core barrel sourcing from `server/`

The new rule immediately found a fourth instance, on a far more widely-imported
artifact than any fixtures barrel. `plugins/conversations/core/index.ts` opened
with

```ts
export { isActiveStatus, hasLiveProcess } from "../server/status";
```

so the browser `core` artifact silently inlined a file out of `server/` while
hashing `core/` + `shared/` only — the same staleness class, and additionally
server source shipped to the browser. Under the general rule the edge becomes
external `@plugins/conversations/server`, the barrel closure tries to build the
conversations **server** barrel as a browser artifact, and the build dies at
`vendor: cannot resolve "node:fs"` after fanning out to 65 server artifacts.
That is the rule working: the edge is what must go. `server/status.ts` is two
pure predicates over `ConversationStatus` with zero server dependencies, already
consumed as core API by both runtimes — it simply lived in the wrong folder, so
it moved to `core/status.ts` and the dead `server/index.ts` re-export was
deleted.

Nothing prevented that edge from being written: `plugin-boundaries` governs the
CROSS-plugin grammar and only resolves alias specifiers through its zone map, so
a relative `../server/x` inside one plugin is invisible to it. The hole is now
closed by a lint rule,
`plugins/framework/plugins/tooling/plugins/lint/plugins/runtime-isolation/`
(`no-cross-runtime-import`): within one plugin, `web/` and `core/` may not
import a sibling `server/` and `server/` may not import a sibling `web/`, in
either spelling (relative, or the plugin's own `@plugins/<own>/server`
self-specifier), type-only imports included. Cross-plugin `@plugins/other/server`
imports stay the boundary config's question. Exactly one violation existed in
the repo; after the move the rule runs clean.

### Blast radius

- One full fleet rebuild (forced by the builder-source digest — unavoidable
  when touching this area, and already the case before the fix).
- Subsequent builds do *less* work: web artifacts stop rebuilding on core-only
  changes.
- Browser: the Layout Lab's fixtures stop double-instantiating their plugin's
  web module.

## Alternatives rejected

- **Widen the hash to the whole plugin dir.** Correct by over-approximation,
  but it makes every `core` artifact rebuild on any `web/` change — a large,
  permanent build-time regression to paper over a table that should simply not
  have existed twice. It also leaves the duplicate-module-instance defect.
- **Record the inlined file set in `meta.json` and re-verify on reuse.** Turns
  a wrong address into a detectable one, but the address stays wrong: two
  different contents still map to one store key, so a *concurrent* build or
  another worktree can still publish and serve the loser. Verification belongs
  under a correct address, not instead of one.
- **Bump `BUILDER_VERSION`.** Unblocks today's build, changes nothing about
  tomorrow's.
