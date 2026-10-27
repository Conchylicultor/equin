# prototypes

Prototypes app — a surface to browse, compare (variants, versions, the real
app) and iterate on throwaway UI design mockups. The mockups live in `~/.equin/apps/prototypes/` —
host-global, shared by every worktree and main, and deliberately **not** in git,
so a mock is live with no build and nothing to commit (the `prototypes` backup
source is what makes it recoverable). Authored separately from this plugin:
**one folder per prototype holding a self-contained `index.html`**, with
its metadata read out of that HTML (`<title>`, `<meta name="description">`,
`<meta name="prototype-viewport">`, `<meta name="mocks">`, `<meta name="prototype-option">`). Nothing is shared between prototypes — no
harness, no tokens, no `meta.json`. `prototypes/CLAUDE.md` is the authoring
contract; **do not edit a prototype from here without reading it.**

**Files are host-global; state is per-instance.** The folders (and their
`_history/`, `_picks/`) are shared by main and every worktree. What the user
says ABOUT a prototype — pinned, Done, its one tag, deleted — and the tag tree itself
are rows in the instance's own DB (`state`): a worktree changes them in its DB
fork without touching main's. Intended.

This top-level plugin is an empty namespace (create-app rule) with one
exception: `data-dirs/index.ts` declares the app's ONE data dir,
`apps/prototypes` (`prototypesDir`, via `defineAppDataDir(prototypesApp, …)`).
It holds the prototype folders and their `_history/`; every sub-plugin that
touches the tree imports it from `@plugins/apps/plugins/prototypes/data-dirs`,
and anything new the app must keep durably goes inside it
(`prototypesDir.subdir("<area>")`), never in a second `apps/*` dir. `shell/core`
must never import it — the declaration reads `prototypesApp` from there.

The same dir is also declared as a **file root** (`infra/paths/data-files`):
`server/internal/roots.ts`'s `prototypesFiles` (portable: an id and the dir's
name, its watch — extensions and catalog name
`prototypes-files.tree` — and the `prototype-picks` ledger over `_picks/`),
bound to `prototypesDir` by `machine/index.ts`'s `FileRootLocation`. Server code
reads and writes the tree through it, so it runs on any host (the disk on the
desktop, memory in a browser host); only host processes (`machine/`, `cli/`,
checks) touch the path. The server barrel's task category is its only other
content. All other content lives in sub-plugins:

- **`files`** — server-side raw file serving out of the data dir, minting new
  prototypes into it from the running checkout's `prototypes/_template/`, the live-state
  list + version resources, and the file-watcher that auto-reloads open iframes
  on edit. Owns the `/api/prototypes` route contract. Also owns each
  prototype's version history (the `PrototypeHistoryStore` host service: a
  private git repo at `_history/<id>.git` on the desktop, snapshots in a
  browser host), the routes that serve and restore a past version, and
  the bodies of the `./equin prototype` verbs.
- **`commands`** — declares the `./equin prototype` group. Its own plugin so
  `list` can read both `files` (the folders) and `state` (which are deleted).
- **`checkpoints`** — the end-of-turn job: when an agent turn ends, records a
  version of every prototype that turn's tool calls named, labelled with the
  turn's request. Its own plugin so `files` never depends on `conversations`.
- **`shell`** — the `Apps.App` rail entry, the app layout, pane registration,
  and the app's own `prototypes` theme.
- **`icons`** — the app's icon family (`prototypesIcons`): the viewer mockup's
  line glyphs, drawn for the Material names the app writes in its scope, plus
  app-only glyphs (`prototypesIcons.icon("compare")`).
- **`state`** — the per-instance DB state: `prototype_state` (pinned, Done,
  one tag per prototype, `deletedAt`) with its PATCH, delete / restore and
  live rows, the prototypes' tag tree
  (`prototype_tags`, a `tag-tree` declaration), and (main only) the adoption
  of the old `_trash/`.
- **`gallery`** — the gallery list pane (a card per prototype, pin, Done and
  Delete on each, grouped by tag as nested sections), its Trash pane, the
  detail header's tag chip, pin, Done and Delete / Restore, and New prototype. Also owns the launch prompt — the
  always-taken path by which prototype agents are launched, and therefore where
  "start from the blank template, never read a sibling" has to be said.
- **`canvas`** — the detail pane: the prototype as a canvas of lettered
  frames (A, B, C…), each with its own options chip and version stepper (frame
  A reads and writes the shared picks, the others hold their own), one
  canvas-wide size & zoom chip, link / spread / keep only, swipe — all
  remembered per pane for the tab's session. Owns the `FrameSource`, frame-actions and detail-wrap slots.
- **`compare`** — the canvas's **Real app** frame: the real thing the
  prototype declares it mocks (`<meta name="mocks" content="<kind>:<ref>">`),
  contributed as a `FrameSource`. Owns the dispatch; each kind of counterpart
  is a child plugin — `exhibit` (one real component from the exhibit catalog)
  and `route` (the running app, framed at a path).
  Also `e2e/compare-diff.ts`, the pixel and colour diff of mock vs app.
- **`present`** — shows one canvas frame without the app around it: Open in a
  new tab and Full screen, two frame actions on every frame.
- **`copy-id`** — the copy-id button in the canvas's header.
- **`thumbnails`** — the rendered PNG behind each gallery card: a
  content-addressed cache, a headless-chromium render job driven by `files`'
  watcher, and the three-armed cover (picture / not yet / visibly failed).

Design: `research/2026-08-15-global-prototypes-self-contained.md` (supersedes
the shared-harness `research/2026-06-16-global-prototypes-design-workflow.md`,
whose app surface still stands).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The Prototypes task category: the category tasks filed from the Prototypes gallery, such as creating or improving a prototype, are grouped under. Declares the app's data dir as the prototypesFiles file root (watched, its _picks ledgered).
- Server:
  - Contributes:
    - `taskCategory` "prototypes"
    - `data-files.root-location` "apps.prototypes"
  - Uses:
    - `infra/paths/data-files.defineFileRoot`
    - `tasks/task-category.TaskCategory`
  - Exports (values): `prototypesFiles`
- Machine:
  - Uses: `infra/paths/data-files.FileRootLocation`
- Cross-plugin:
  - Imported by:
    - `apps/prototypes/files`
    - `apps/prototypes/files/snapshot-history`
    - `apps/prototypes/thumbnails`
- Core:
  - Exports (values): `PROTOTYPES_CATEGORY_ID`
- Sub-plugins:
  - **`canvas`** — The prototype detail pane as a canvas of frames: the prototype (frame A reads and writes the shared option picks, every other frame holds its own), each with its own options chip and version stepper…
  - **`checkpoints`** — Records a version of every prototype an agent turn touched, at the end of that turn: reads the turn's window out of the conversation transcript, finds the prototype ids its tool calls named…
  - **`commands`** — The ./equin prototype command group (new, list, options, log, checkpoint, restore): declared here, above files and state, so list can leave out the prototypes deleted in this checkout's instance.
  - **`compare`** — The prototype canvas's "Real app" frame: the real app thing a prototype declares it mocks (<meta name="mocks" content="<kind>:<ref>">), resolved through the open Counterpart.Kind registry and…
    - Plugins:
      - **`exhibit`** — The exhibit: counterpart kind for the prototype canvas's Real app frame: one real app component, looked up by id (exhibit:<id>) in the exhibit catalog (plugin-meta/exhibits — any plugin's exhibits/…
      - **`route`** — The route: and app: counterpart kinds for the prototype canvas's Real app frame: the running app itself, framed at an in-app path on this deploy's own origin — chromeless for route…
  - **`copy-id`** — Copy prototype ID button in the prototype detail header: copies the open prototype's id (its minted folder name) to the clipboard.
  - **`files`** [test helpers] — Registers the prototype id kind (`proto-…`) in the browser's id-kind registry. Serves the prototypes tree (the app's prototypesFiles root over the `apps/prototypes` data dir — the computer's disk on…
    - Plugins:
      - **`snapshot-history`** (excluded) — Prototype version history for a host without the computer (the browser composition): provides the PrototypeHistoryStore host service as content-addressed snapshots over the prototypesFiles root…
  - **`gallery`** — Prototypes gallery list pane — one card per prototype over its rendered preview, on the prototype viewer's grid, with a Recently edited list; grouped by its tag as nested sections along the…
  - **`icons`** — Contributes the prototypes icon family (prototypesIcons) to Icons.Family, so a scope whose iconFamily is prototypes — the Prototypes theme's — draws its glyphs.
  - **`present`** — Open in a new tab on every gallery card (its live present page) and two frame actions on every prototype canvas frame: Open in a new tab (the frame's chromeless present page at the Responsive size…
  - **`shell`** — App shell for Prototypes. Registers the /prototypes app entry and renders the gallery + detail panes (the gallery, and the canvas of frames) full-surface: opening a prototype replaces the gallery…
  - **`state`** — Per-instance prototype state, web half: registers the prototype tag id kind (`prtag-…`), and the hooks reading and writing a prototype's pinned / Done / tag state (usePrototypeStates…
  - **`thumbnails`** — The rendered-preview cover for a prototype card: the cached PNG, the caller's fallback while it renders, and a visible 'Preview failed' marker carrying the reason. Rendered PNG previews for the…
    - Plugins:
      - **`no-renderer`** (excluded) — The prototype thumbnails of a host without a browser to render with: provides the ThumbnailRenderer host service as unavailable, so a cache miss is the card's muted 'Preview unavailable' marker and…

<!-- AUTOGENERATED:END -->
