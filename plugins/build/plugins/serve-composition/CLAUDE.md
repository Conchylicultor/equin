# serve-composition

The **serve capability** for a composition: build it into its own frontend dist
and empty database and serve it live at
`http://<id>.<checkout>.localhost:9000` — `http://<id>.localhost:9000` when the
checkout is main, where the suffix elides. It owns no surface of its own — it
exports the pieces its hosts render:

- `ServeTargetPanel({ item, status })` — the **Serve live** target panel: the
  `Serve`/`Serving` `ToggleChip`, the rebuild-mode picker, **Rebuild now**, and —
  only when the composition is genuinely served — the live-URL `LinkChip`, its
  commit + build time, and **Reset**.
- `useServeComposition()` — `{ setMode, rebuildNow }`. `setMode(id, mode)` writes
  the `serve` mode, and POSTs `serveCompositionEndpoint` (`@plugins/build/core`)
  ONLY on the `off` → served edge — that is the first claim of the namespace, and
  nothing is there yet. Moving between two served modes writes config only: the
  namespace is already live and the mode says only when it may be refreshed, so
  building there would rebuild on every click of the picker. `rebuildNow(id)`
  POSTs unconditionally, and every mode offers it — see below.
  Turning the mode to `off` stops nothing: deactivating is deliberately never a
  reclaim trigger, so the namespace keeps serving its last dist until the
  composition is deleted.
- `useServeStatus(compositionId)` — the liveness read (below).
- `useDeleteComposition()` — `{ deleteComposition }`. Deleting a composition,
  including everything it is serving (below).

Hosts today: Studio's **Build & serve** section and Compositions list, and the
deploy pane's **Test locally** section
(`apps/deploy/local-serve`).

## Why it lives under `build`, not under Studio

It used to be `apps/studio/compositions/auto-serve`. Nothing about it was ever a
Studio concern: it depends only on `plugin-meta/composition`, `build/core`,
`infra/*` and primitives. When the deploy pane needed the same capability, keeping
it there would have created the repo's **first `apps/X → apps/Y` import edge** —
there are none, and one app reaching into another app's subtree is exactly the
coupling the plugin boundaries exist to prevent.

`build` is where it belongs on the merits: `build` already owns
`POST /api/build/serve` and the CLI's build verb, which is the thing this
plugin's controls start and whose output they report. The move introduces no
cycle — `build` and `plugin-meta` have no edge in either direction — and the
routes moved with it (`/api/build/serve/{status,reset}`), so no path claims a
Studio namespace it no longer belongs to. Design:
[`research/2026-08-05-global-deploy-pane-test-locally-and-one-button-deploy.md`](../../../../research/2026-08-05-global-deploy-pane-test-locally-and-one-button-deploy.md)
(Phase B).

To keep the import graph a DAG this plugin still imports none of its hosts; the
edges all run inward (`studio/compositions → serve-composition`,
`studio/compositions/release → serve-composition`,
`deploy/local-serve → serve-composition`).

## Rebuild now exists in every mode, on purpose

The automatic modes (`push`, `hourly`, `daily`, `weekly`) are one clause of the
build convergence loop — see `plugins/build/CLAUDE.md`. Two of its properties
shape this UI:

- Its gate compares this checkout's HEAD against the commit the marker records,
  so it is **blind to an edit of the composition's own manifest row**
  (contributors, entry points, `extends`), which changes what should be served
  without moving HEAD. **Rebuild now** is that escape hatch, which is why no mode
  hides it. It doubles as the retry for a first serve build that failed.
- The automatic edges run on **main only**, so the status read carries
  `autoTriggersHere` and a worktree's panel says so instead of offering a trigger
  nothing here will act on.

## Intent is not liveness

The `serve` mode is a **declared intent** stored in the `compositions` config.
The truth is the `composition.json` **marker** a serve build writes into the
namespace dir before it composes anything. The two disagree routinely — the
enabling build has not run yet, or it failed — and a surface that reads the mode
as liveness offers a link to a namespace that 502s.

So `GET /api/build/serve/status?composition=<id>` answers three questions at
once:

- `namespace` + `url` — WHERE this composition is (or would be) served from the
  backend that answered: `namespaceFor(id, <that backend's checkout>)`. Server
  truth, and it has to be — see the section below.
- `liveness` — `{ served: false }` or `{ served: true, commit, builtAt }`. A
  discriminated union, so a missing commit cannot be read as a live serve. The
  marker is on the shared filesystem, so **any** backend can answer this.
- `autoTriggersHere` — whether the automatic modes are acted on by the backend
  that answered. Like `namespace`, a fact about THIS BACKEND rather than about
  the composition.

There is **no `canServe`** any more. It used to answer "is this backend main?",
because the serve stage ran inside main's build and every other namespace could
only observe. A serve is now an ordinary build of whichever checkout you are
looking at, so the only thing that can refuse is the composition itself: main's,
whose namespace is where that checkout's own `./singularity build` deploys. That
is `isServableCompositionId(id)` — pure, synchronous, and callable by every
surface, so no round-trip is needed to know whether a control can succeed.

`useServeStatus` returns the read as a discriminated `ServeStatus`
(`pending | error | ready`) — a failed read is a state a host renders, never an
absence that reads as "not served". Freshness is push-based: it refetches when
the newest terminal `build.history` run whose `targets` include this composition
changes. Nothing polls.

`commit` comes from the marker, stamped with the commit the build took the lock
at. Markers written before that field existed carry none and report `null` —
unknown, never guessed.

`ServeTargetPanel` takes `status` as a **prop** rather than calling the hook, so
a host that already needs the answer for an affordance of its own (a list row's
serve shortcut) asks once and hands the same snapshot to the panel.

## Reset to first-launch

Once a composition is served, the panel also shows a destructive **Reset** button
next to the serve-URL chip. It opens a confirm dialog and, on confirm, `POST`s
`resetCompositionData` (`/api/build/serve/reset`), which wipes *only that one
namespace's* Postgres DB and config dir `~/.singularity/state/config/<ns>/` back
to exactly what a serve build provisions on a fresh serve, then restarts its
backend — so the author sees the genuine new-user experience. It is a
**narrower `reapAttempt`**: the spec + dist + code are kept (the app stays
served); only DB + config are reset.

Like the status read, it resolves the namespace from the answering backend's own
checkout, so Reset in a worktree's Studio resets `<id>.<checkout>` and cannot
reach the one main serves.

The config is **re-propagated**, not merely deleted: a bare `rm -rf` would fall
back to *code* defaults, whereas re-running `propagateConfigToUser` restores the
shipped **git-layer** first-launch defaults `serveOne` installs.

**Main is never touched.** `server/internal/reset.ts` gates on four checks, and
throws `CompositionResetError` (nothing touched) if any fails:

1. `assertServableCompositionNamespace(id)` — rejects the reserved
   `{central, singularity, main}` namespaces. The explicit "never main" gate.
2. `hasCompositionMarker(id)` — the `composition.json` provenance marker must
   exist (proves a serve build owns this namespace).
3. `namespaceCollision(id, probeNamespace(mainRoot, id)) === null` — no real git
   worktree dir / branch / marker-less spec dir of that name. Probed against the
   MAIN checkout, not this backend's: everything else here reads this checkout's
   own manifest and config, but `.claude/worktrees/` exists only in main, so a
   worktree backend probing its own root could never see that arm at all.
4. `id`'s `serve` mode is not `off` in **this checkout's** resolved config
   (belt-and-suspenders; guard 2 is the decisive one).

### In scope vs out of scope

- **In scope:** the namespace's DB and its config dir. Both are named by the
  namespace, so the reset is provably confined to that one namespace.
- **Out of scope (deliberately ignored):** central secrets / auth tokens. They
  live in one global encrypted store (`~/.singularity/state/secrets/secrets.json.enc`) shared by
  every namespace under the single-instance-per-user architecture
  ([ADR](../../../../research/2026-07-02-global-adr-single-instance-per-user.md)),
  carry no per-composition dimension, and are not part of this reset. Documented,
  not worked around.

All four endpoint contracts live in `shared/endpoints.ts` (imported by both this
plugin's own web and server); the tolerant gateway restart (404 = not running,
gateway-down = fine) mirrors the CLI's, minus its `closeAdminPool()`.

## Deleting a composition takes its namespaces with it

A composition is not just a config row. Building it mints a namespace, and a
namespace is a live address, a Postgres database, a config dir and a built
frontend. Dropping the row on its own left every one of those on disk forever
**and** made them invisible at the same moment, because every composition-aware
surface is keyed off the row that just vanished.

`useDeleteComposition()` is that whole concept, in one place, and both Studio
delete buttons call it (the list row's and the draft editor's), so they cannot
drift:

1. `GET /api/build/serve/owned?composition=<id>` — what does it own? The button
   pends while this is in flight; until the server answers we do not know whether
   the delete is free or destroys a live database, and "owns nothing" is not a
   thing to render before we know.
2. If it owns nothing — no serve build ever ran — the row is removed with no
   dialog. There would be nothing to warn about, and a scary prompt over an empty
   list teaches people to click through the one that matters.
3. Otherwise a `confirmDialog` names **every** namespace: its host, which
   checkout built it, and whether a database goes with it. Not a count — a count
   cannot tell you that one of the three is the one on main holding your content.
4. On confirm, `POST /api/build/serve/reclaim` reclaims them and only then is the
   row removed. `remove(id)` in `plugin-meta/composition` stays the pure
   synchronous config edit its name promises.

**Not scoped to this checkout**, unlike Reset. `sonata` served from main and
`sonata.att-x` served from three worktrees are four namespaces, four databases
and four config dirs, and deleting the composition strands all four. The
inventory is a marker scan across every namespace on the host
(`namespacesOwnedByComposition`), and one backend can reclaim namespaces composed
by other checkouts because all of it lives in the shared `~/.singularity/` tree.

**Per-namespace outcomes, never a tally.** Each namespace comes back as
`reclaimed` / `refused` (a guard rejected it, nothing touched) / `failed` (it
broke part-way). One failure does not abort the others — they are independent
sets of artifacts — and if ANY is short of reclaimed the manifest row **stays**:
it is the only remaining handle on a namespace that did not come back, and
removing it is exactly how one becomes invisible. The dialog stays open with the
reason on it, so retrying is one click.

**Which of Reset's four guards carry over** (see
`server/internal/reclaim-composition.ts`): `assertServableCompositionNamespace`
and `hasCompositionMarker` do, both enforced inside `reclaimNamespace`.
`namespaceCollision` does not — it answers "may this owner *claim* this name?"
and is already enforced at both claim sites, so re-running it at reclaim time
would mean refusing to give back a name a collision made unreachable.
**"must be currently served" must not** — you delete a composition
precisely when its serve intent is already off, so that guard would refuse
exactly the namespaces most in need of reclaiming.

Design:
[`research/2026-08-20-global-composition-namespace-reclaim.md`](../../../../research/2026-08-20-global-composition-namespace-reclaim.md)
(Trigger B).

## Pass the item's `id`; the SERVER says what namespace that is

Two different things used to be one. The id is still the only thing a consumer
may pass — for UI-created compositions `id` is a uuid while `name` is whatever
the user typed, so the two genuinely diverge, and the deploy app (name-keyed
throughout) looks the item up by `name` before handing the `id` here.

But the id is no longer the namespace. A composition is served from whichever
checkout built it, so it is `sonata` from main and `sonata.att-x` from a
worktree, and a single-label namespace is ambiguous by construction — `foo` could
be composition `foo` on main or the main app on checkout `foo`. The browser knows
only the namespace it is talking to, which does not decompose back into a pair.
So no client composes a namespace: `serveStatusEndpoint` returns the resolved
`namespace` and `url`, and the marker records the `(composition, checkout)` pair
where it was minted. If you find yourself writing `asNamespace(item.id)` in web
code, that is the bug this section exists to prevent.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Serve capability for a composition: the live-serve toggle panel, the enable→build hook (a `build --composition <id>` of THIS checkout), the served-liveness read (the server-resolved namespace plus the composition.json marker, not the autoBuild intent), and the delete flow — which asks what the composition owns across every checkout, names it in a confirm dialog, and reclaims it before the manifest row goes. Consumed by Studio's Build & serve section and compositions list, and by the deploy pane's Test locally section. Serve-liveness read for a composition: WHERE this backend's checkout serves it (the server-resolved namespace + url) and whether anything is actually there (the composition.json marker), plus the reset-to-first-launch endpoint — wipes ONLY that namespace's DB + config back to what a serve build provisions on a fresh serve, then restarts its backend. Never touches the checkout's own app. Also answers what a composition owns across EVERY checkout that has served it (the marker scan behind the delete confirmation) and reclaims that whole set, per-namespace outcomes reported individually.
- Web:
  - Uses: 21 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/endpoints` ×4
    - `primitives/css/toggle-chip` ×3
    - `network/live` ×2
    - `plugin-meta/composition` ×2
    - `primitives/css/badge.Badge`
    - `primitives/css/link-chip.LinkChip`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/live-state.foldResource`
    - `primitives/overlay/imperative-dialog/confirm.confirmDialog`
    - `primitives/relative-time.RelativeTime`
    - `shell/toast.showToast`
  - Exports (types):
    - `DeleteCompositionRequest`
    - `ServeStatus`
  - Exports (values):
    - `ServeTargetPanel`
    - `useDeleteComposition`
    - `useServeComposition`
    - `useServeStatus`
- Server:
  - Uses:
    - `database/admin.databaseExists`
    - `database/admin.dropDatabase`
    - `database/admin.ensureDatabase`
    - `infra/endpoints.implement`
    - `infra/paths.checkoutRef`
    - `infra/paths.REPO_ROOT`
    - `infra/worktree.ensureMainWorktreeRoot`
    - `infra/worktree.hasCompositionMarker`
    - `infra/worktree.namespaceCollision`
    - `infra/worktree.probeNamespace`
    - `infra/worktree.readCompositionMarker`
    - `infra/worktree/reclaim.NamespaceReclaimError`
    - `infra/worktree/reclaim.namespacesOwnedByComposition`
    - `infra/worktree/reclaim.OwnedNamespace`
    - `infra/worktree/reclaim.reclaimNamespace`
  - Routes:
    - `POST /api/build/serve/reset`
    - `GET /api/build/serve/status`
    - `GET /api/build/serve/owned`
    - `POST /api/build/serve/reclaim`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/local-serve`
    - `apps/studio/compositions`
    - `apps/studio/compositions/draft-actions`
    - `apps/studio/compositions/release`
- Exemptions:
  - Exempts itself from:
    - `live/no-endpoint-read` — `web/internal/use-serve-status.ts` (debt)
    - `boundaries/no-platform-api` — `server/internal/reset.ts` (debt)

<!-- AUTOGENERATED:END -->
