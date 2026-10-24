# Pane `input`: split the display hint from the pane option, and make the hint unwritable

## Context

`Pane.define({ input: type<T>() })` carries caller-supplied, non-URL state. It is persisted in
`history.state` (and mirrored to `sessionStorage` by `apps-core/tabs`, to `localStorage` by
`conversations/pane-restore`). On a direct URL navigation, reload, or bookmark, the route is rebuilt
from the URL alone — the bag is `{}` and `useInput(): Partial<Input>` returns undefined fields.

Nothing in the type system distinguishes *"an optimistic display hint that is absent on a deep link"*
from *ordinary pane data*. A consumer that reads `useInput()`, applies `?? "<default>"`, and feeds the
result into a mutation writes a fabricated value to the DB. That is exactly what happened to a Sonata
song's title (fixed in `01889eebd`; post-mortem in
[`2026-07-10-sonata-song-title-single-owner.md`](2026-07-10-sonata-song-title-single-owner.md)):
`/sonata/song/:id` deep-linked, the pane seeded an app-context mirror with `input.title ?? "Untitled"`,
and the chord-grid autosave persisted `"Untitled"` over the real name.

The instance is fixed; the **affordance is intact**. `input` still looks like ordinary pane data — the
pane `CLAUDE.md` even demonstrates it as `preloadedTitle` with no warning about write paths. Today's
other consumers happen to be display-only or identity, so nothing is currently broken. This document is
about making the next occurrence impossible.

## What the survey found

Nine panes declare `input`. They are **not one concept**; they are three, and the middle one is the
only genuinely dangerous kind:

| Bucket | Meaning | Absence means | Panes |
|---|---|---|---|
| **Ambient identity** | The value is already in the route | Read it from the route | the 8 `{convId: string}` satellite panes |
| **Hint** | An optimistic **mirror of server-owned state**, to pre-paint before the canonical resource settles | Wait for canonical | sonata `{title}`, mail `MailMessage` envelope |
| **Option** | Opener-supplied UI configuration with **no canonical owner** | The default | task-detail `{focused?}`, studio-graph `{focusId?}` |

Plus one dead declaration (`story` `{title}`: declared, opened with, never read) and one dead *use*
(`attempt-switch-button` passes `input: { convId }` to `attemptPane`, which declares no input and reads
the route instead — accepted only because the `Input` generic defaults to `Record<string, unknown>`).

Two structural observations follow:

1. **The `convId` bucket is pure redundancy.** Every one of those panes already reads
   `input.convId ?? conversationPane.useRouteEntry()?.params.convId`, and `conversationPane` is always
   present in the route when they open (they are contributed to the conversation toolbar) *and* on a
   deep link (it is their URL ancestor). The `input` half of that `??` never wins. Deleting it removes
   8 of the 11 declarations.

   It is also actively load-bearing for a **broken affordance**: `promote()` copies the slot's `input`
   into a fresh root route, so a promoted `/review` keeps working *in memory* while its URL
   (`/review`, no `convId`) cannot be rebuilt on reload. These panes are conversation-scoped satellites
   and must declare `chrome: { promote: false }`.

2. **Absence is only fabricable because it reaches the read site.** No type can distinguish a *display*
   default from a *write* default — that distinction lives at the sink, not the source. But if absence
   is never observable at the read site, `?? "<fabricated>"` has nothing to attach to. Each of the two
   remaining buckets can achieve that, differently.

## Design

> **The invariant.** Non-URL pane state is either an **option** (no canonical owner; its deep-link value
> is a compile-time default declared once, at the pane) or a **hint** (a mirror of server-owned state;
> observable *only* alongside its canonical source, never persisted, never a write source). There is no
> third kind, and `input` — which was all three at once — ceases to exist.

### `options` — absence resolved once, at the definition

```ts
export const taskDetailPane = Pane.define({
  …,
  options: { focused: false },        // ← a literal DEFAULTS record, not a type marker
});

const { focused } = taskDetailPane.useOptions();   // boolean — TOTAL, never Partial
```

`useOptions()` returns `{ ...optionDefaults, ...slot.options }`. The deep-link value is stated once, in
the pane definition, instead of being re-invented at every read site with a `??`. Openers pass a
`Partial<Options>`; the slot stores only that partial, so changing a default later applies to routes
already in `history.state`.

Because `Options` defaults to `{}`, a pane that declares no options now **rejects** a stray
`options: { convId }` at the call site (excess-property check) — the hole that let
`attempt-switch-button` pass dead input for years.

### `hint` — observable only next to its canonical source, and never persisted

```ts
export const sonataPlayerPane = Pane.define({
  …,
  hint: type<{ title: string }>(),
  useTitle: (params, hint, options) => { … },
});

interface Hint<T extends object> {
  /** Canonical wins; the hint only fills the gap while canonical is `undefined`. */
  pick<K extends keyof T>(key: K, canonical: T[K] | undefined): T[K] | undefined;
}
```

`Hint<T>` is a **closure with no enumerable data**. `pick` is the only accessor and it *requires* the
canonical expression as an argument. Therefore:

- A hinted value can never be obtained "bare". You cannot write `hint.title` — you must already hold
  the truth to see the hint at all, and if you hold the truth you have no reason to write the hint.
- The sonata shape (`setCurrentSong({ title: input.title ?? "Untitled" })`) is not expressible.
- `pick` returns `T[K] | undefined` and the primitive **never** launders that into a value.

**The hint is ephemeral.** It lives in the in-memory `PaneSlot` only and is stripped from every
serialized form (`history.state`, `tabs` sessionStorage, `pane-restore` localStorage). A hint's entire
job is to pre-paint between the `openPane` call and the first settle of the canonical resource, in the
session that opened it. A reload or back/forward has no opener; canonical settles within a tick and the
hint buys nothing — while a *persisted* hint would be an arbitrarily stale mirror masquerading as data.
Two consequences:

- **A hint cannot outlive the navigation that created it.** That is the strongest possible statement
  that a hint is not pane data.
- Mail's `envelope.internalDate instanceof Date` guard becomes provably dead and is deleted. (It exists
  because `tabs`/`pane-restore` persist through `JSON.stringify`, which turns a `Date` into a string —
  `history.state`'s structured clone does not. An ephemeral hint never makes that trip, so
  `pick("internalDate", …)` is type-honest.)

Consequently `routesEqual` and `openPaneImpl`'s slot-dedupe compare `options` only. This is
load-bearing: `setRoute` dispatches a synthetic `popstate`, and if `routesEqual` counted the hint, the
`handleLocationChange` rebuild (from hint-less `history.state`) would immediately wipe the hint it just
painted with.

### `pane/no-hint-fabrication` — closing the last laundering step

`pick(key, canonical)` still yields `T[K] | undefined`, and `undefined ?? "Untitled"` is one keystroke
away. A lint rule in `plugins/primitives/plugins/pane/lint/`, shaped byte-for-byte after
`live-state/lint/no-pending-data-collapse.ts` (scope-resolution based, not type-aware):

| Expression (`h` = a `useHint()` binding, or a param annotated `Hint<…>`) | Verdict |
|---|---|
| `h.pick("k", undefined)` / `h.pick("k", null)` | **error** — recovers the bare hint |
| `h.pick("k", x) ?? "Untitled"` (any non-nullish, non-JSX right operand) | **error** — fabrication |
| `h.pick("k", x) \|\| 0` | **error** |
| `const v = h.pick("k", x); … v ?? "y"` (one-level const, same scope) | **error** |
| `h.pick("k", canonicalExpr)` | ok |
| `h.pick("k", x) ?? null` / `?? undefined` | ok — honest absence |
| `h.pick("k", x) ?? <Placeholder>Untitled</Placeholder>` | ok — a ReactNode can never be a DB value |

The non-JSX carve-out is the same trick the sibling rule uses, and it is the teachable rule: **a hint's
fallback must be a ReactNode.**

### The residual holes, stated plainly

**No type can distinguish a display default from a write default** — that distinction lives at the
*sink*, not the source. Everything above attacks the source instead: it makes absence unrepresentable
(`options`) or unobservable-in-isolation (`hint`). Two escapes survive, both by design:

1. **A misfiled option.** Nothing stops `options: { title: "Untitled" }` — a server-owned field with a
   fabricated default — re-creating the bug. Not structurally closable: option defaults are arbitrary
   literals. What changes is that the lie is now a single static literal co-located with the pane
   declaration, rather than a `??` buried three files away at a debounced write; and nothing ever writes
   `options` back. We accept "one visible lie at one reviewable site" and document the discriminator
   (*if a key's default would be a lie about server state, it is a hint, not an option*). We do **not**
   add a heuristic lint here — it would misfire on every legitimate enum default.

2. **Two-step laundering.** `no-hint-fabrication` tracks one level of const. So
   `const s = h.pick("k", c) ?? null;` (legal — honest absence) followed later by `s ?? "Untitled"` is
   not flagged: by then `s` is an ordinary nullable string flowing into a display prop, indistinguishable
   from any other. Chasing it further is taint analysis, which we deliberately do not attempt. The rule's
   job is to stop the one-step reach for a default *because the hint might be missing* — which is exactly
   the shape the Sonata bug had, and which it does catch (verified against the original code, re-spelled).

The deepest guarantee is not in this plugin at all: it is the one the post-mortem drew — **a partial edit
must not ship a full snapshot**. The chord-grid endpoint dropping `title` from its body is what made the
bug class unrepresentable end-to-end. This document makes the *source* of the fabricated value
unavailable; endpoint design is what makes the *sink* refuse it.

## Back-compat

All three persistence sinks are client-ephemeral: `history.state` (page session), `tabs` sessionStorage
(browser-tab lifetime), `pane-restore` localStorage (30-day TTL). **No DB, no server.** After the split,
a persisted slot carrying the legacy `input` key deserializes with `options` absent → `useOptions()`
returns defaults; `hint` is absent by design. The only observable effect is that an already-open
session, on its first back/forward after deploy, sees a focused task-detail revert to its default mode
once, then self-heals. No migration shim — adding one would be three lines of debt for a cosmetic,
self-healing, session-scoped blip.

## Files

**Primitive**
- `plugins/primitives/plugins/pane/web/pane.ts` — `PaneSlot.{options,hint}`; `Hint<T>` + `makeHint`;
  `PaneInternal.optionDefaults`; `useOptions()`/`useHint()` replace `useInput()`; `DefineArgs` /
  `RouteDefineArgs` gain `options`/`hint`, lose `input`; `PaneObject` gains `Options`/`HintT` generics;
  `setRoute` serialization omits `hint`; `restoreRoute`/`handleLocationChange` rebuild `hint = {}`;
  `routesEqual` + `sameInput` → options-only; `promote` carries options, drops hint;
  `openPane`/`useOpenPane`/`useToggle`/`PaneToggleOpts`/`OpenPaneFn` take `{ options?, hint? }`;
  `usePaneTitle(pane, params, hint, options)`; `PaneRouteEntry.input` → `.options`; `MatchEntry`
  carries both.
- `plugins/primitives/plugins/pane/web/index.ts` — export `Hint`, drop `PaneInput` if unused externally.
- `plugins/primitives/plugins/pane/lint/{no-hint-fabrication.ts,no-hint-fabrication.test.ts,index.ts}`
- `plugins/primitives/plugins/pane/web/pane-write-path-types.test.ts` — `@ts-expect-error` assertions:
  `useInput` gone; stray `options`/`hint` keys rejected on a pane declaring none; `useOptions()` total;
  `pick` requires two args.
- `plugins/primitives/plugins/pane/CLAUDE.md` — replace the **Input** section with **Options** +
  **Hint**, with the write-source warning and the lint rule.

**Serialization boundaries** (strip hint, rename `input` → `options`)
- `plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx` (`usePaneTitle` call)
- `plugins/apps-core/plugins/tabs/web/internal/tabs-store.ts`
- `plugins/conversations/plugins/pane-restore/web/internal/pane-restore-store.ts`

**Primitive, additionally**
- `AnyPane` (`= PaneObject<any, any, any, any>`) is exported and used at every "some pane, whichever"
  position (`Pane.Register`'s slot, `PaneChrome`'s prop, the layout host). Those sites previously spelled
  `PaneObject<any, any, any>`, which silently picked up the strict `NoOptions`/`NoHint` generic defaults
  and rejected every real options/hint pane by invariance. Naming it once means the next generic added to
  `PaneObject` cannot re-break them.

**Bucket 1 — delete `input`, add `chrome: { promote: false }`** (satellite panes + their openers)
`review`, `conversations/summary`, `code-explorer` (conv-file-tree), `conversation-view/{terminal-pane,
push-profiling, commits-graph (×2), code/docs-button, jsonl-viewer/tool-call/{agent,workflow}}`; openers
`review-button`, `summarize-button`, `conv-tree-button`, `terminal-button`, `open-terminal-button`,
`docs-button`, `commits-chip`, `push-profiling-button`, and the dead `attempt-switch-button`.
Also delete story's dead `input` (`apps/story/shell/web/panes.tsx`, `story-gallery.tsx`).

**Bucket 2 — options**
`tasks/task-detail/web/panes.tsx` (+ `expand-task-action.tsx`, `active-data/task-link`),
`apps/studio/graph/web/panes.tsx` (+ its opener).

**Bucket 3 — hint**
`apps/sonata/library/web/panes.tsx` (+ `useOpenSong` / `openSongImperative`),
`apps/mail/search/web/{panes.tsx,components/mail-message-reader.tsx}` (+ its opener; delete the
`instanceof Date` guard).

## Verification

1. `./equin check type-check` — the `@ts-expect-error` harness in `pane-write-path-types.test.ts`
   fails the build if any assertion stops being an error.
2. `bun test plugins/primitives/plugins/pane` — lint-rule fire/no-fire matrix + type harness.
3. `./equin build`, then drive the real app:
   - **The original bug, end-to-end.** Deep-link `http://<wt>.localhost:9000/sonata/song/<id>` for a
     chord-grid song, type in the grid, wait past the 500 ms autosave, then
     `query_db: select title from sonata_songs where id = …` → unchanged. (Also assert the tab title
     shows the real name, i.e. the hint path still pre-paints when opened from the Library gallery.)
   - **Satellites.** Open a conversation, toggle Review / Terminal / Commits / Docs — each resolves
     `convId` from the route. Reload each satellite's deep link. Confirm no promote button.
   - **Options.** Click a task chip in an assistant message (`task-link-chip`, `focused: true`) → the
     focused detail body renders; deep-link the same URL → the inline-tree body renders (the default).
   - **Hint.** Open a mail search result → header pre-paints from the envelope before hydrate returns;
     reload → header fills in from hydrate with no crash and no string/Date confusion.
4. `./equin check` (full) — `plugins-doc-in-sync`, boundaries, eslint.
