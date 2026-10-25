# gallery

The Prototypes app's gallery: the list of every prototype, and New prototype.

- **Gallery pane** (`/prototypes`) — a `DataViewSwitcher` over the live
  `prototypesList` value (two sources — see **Delete and the Trash**), with a
  Gallery view (cards grouped by tag, nested), a Recently edited list and a
  Trash view (`config/apps/prototypes/gallery/prototypes.gallery.jsonc`). The pane lies on
  the viewer's own ground: `PaneChrome`'s `ground` prop takes `canvas`'
  `<CanvasGround>` (the 28px grid under its vignette), which stays put while
  the cards scroll over it. Activating a card pushes the detail pane (the
  `canvas` plugin). A "New prototype" button opens a `LaunchAgentPopover` that
  mints first (see below). The shell theme sizes the cards (`galleryCardMin`,
  `galleryGap*`, `radiusCover`, `shadow-cover` / `-hover` — the gallery mock's
  `.grid` / `.shot`).

  **The cover** is the DataView's `cover` accessor: `kind: "node"` holding
  `thumbnails`' `<PrototypeThumbnail>` (the card's picture and the list row's
  thumbnail). `CoverSwatch` — the id-tinted gradient — stays here as the
  stand-in the thumbnail falls back to before its picture exists, or when
  rendering it failed. This pane owns the stand-in; `thumbnails` owns the
  picture.

  **The fields** (`web/internal/gallery-fields.tsx`, `galleryFields(tags)`) are
  the card's three lines (`partitionCardFields`): the `<title>` (primary), the
  problems count as an `indicator` after it (absent — so omitted — when there
  are none; the problems themselves are listed in the detail pane), the blurb
  as the subtitle, then `modifiedAt` (`schedule` icon, relative time) and
  `versions` (`history` icon, "v12") as tokens. A prototype with no known
  version count has `versions: undefined`, so the token is omitted — never
  "v0". `name` (the minted id, the row key and URL param), `createdAt`,
  `status` and `tag` are hidden sort / filter / group dimensions.

  **Five values are subscribed together, by each source's `PrototypeShelf`** (`useCombinedResources` over
  `useLive(prototypesList)`, `usePrototypeThumbnails()`, `state`'s
  `usePrototypeStates()` and tag tree (`useTagTree(prototypeTagTree)`), and
  `useLive(prototypeVersionCounts)`), and the cards wait for all of them. A
  value is filled by its subscription's first answer, asked for when its first
  subscriber mounts, so subscribing to the thumbnails (or counts) down inside a
  card would put that ask strictly after the list had painted — a guaranteed
  late paint on every load. Side by side they are answered in parallel, and the
  card is right the first time it is painted. `joinGalleryRows` maps the
  states (per-instance DB rows; no row = `NO_PROTOTYPE_STATE`) and counts onto
  the rows (`PrototypeGalleryRow = PrototypeMeta & { done, pinned, tagId,
  deletedAt, versions }`), so everything reads one value:
  - a hidden `tag` field (`type: "tag"`, options `tagFieldOptions(tags)`) — the
    DEFAULT grouping, `tree` (nested sections along the tag tree, rolled-up
    counts, untagged under None last);
  - a hidden `status` enum ("Pinned" / "In progress" / "Done", not the two
    bools: it reads as section headings and filter values, where "No" / "Yes"
    say nothing). The default view SORTS by it, so pinned cards head each tag
    section and Done ones close it; group by it for the old three sections. A
    pin outranks Done;
  - a muted title on Done cards (`rowTone`);
  - the card actions.

  **Pin / Done / Open in a new tab — the card actions** (`PrototypeCardActions`,
  the same set on a gallery card and a list row). Pin (`PinCardAction`) and the
  Done circle (`DoneCardAction`) are `revealed` (hover) actions with
  `useActive` (`usePinnedActive` / `useDoneActive`, a plain read of the joined
  row): a set state stays painted at rest, the rest appear on hover. Both
  write through `state`'s `useSetPrototypeState` (`PATCH …/state`, the fields
  it sets — a change never clobbers another field) and their click never opens
  the card. Open in a new tab is contributed by `present` (the live present
  page).

  The canvas's header (`prototypeDetailPane.Actions`, order in
  `config/apps/prototypes/canvas/prototypes-detail.actions.jsonc`) gets, right
  after the title, `TagHeaderAction` (`tag-chip.tsx`: `TagPickerPopover` +
  `TagPathChip`, `offerNone`, counts = `rolledUpTagCounts` over the listed
  prototypes' tags), then `PinHeaderAction` and `DoneHeaderAction` — each
  reading `usePrototypeState(name)` and pending until it is known, with fixed
  labels so toggling never changes the header's width — and, after a rule,
  `DeleteHeaderAction`.

- **Delete and the Trash.** Delete (a card action, and the detail header's —
  which reads Restore on a deleted prototype) records `deletedAt` in the
  prototype's state row (`state`'s `DELETE /api/prototypes/:name`); the folder
  stays. Per instance like the rest of the state: a delete in a worktree never
  deletes on main. No confirm dialog: it is reversible, and its toast's Undo
  restores at once (`POST …/restore`). The Trash is a **view**, not a pane:
  the gallery is one `DataViewSwitcher` over two contributed sources
  (`PrototypeGallerySources`) — `gallery` (rows with `deletedAt === null`,
  `PrototypeCardActions`) and `trash` (the deleted rows, `trashFields` adding
  **Deleted**, `PrototypeTrashActions` = Restore). Every row of
  `config/apps/prototypes/gallery/prototypes.gallery.jsonc` binds to one by its
  `source` key, so a view the user adds reads one or the other and never needs
  a "not deleted" filter. Opening a Trash card shows its canvas, which carries
  the deleted notice.

The detail pane itself — the canvas of frames, its version steppers, option
picks, size and zoom — is the sibling `canvas` plugin. The gallery depends on
it to put its tag chip, pin, Done and Delete in the canvas's header and for
the ground it sits on (`CanvasGround`); the routes of both panes
live in `shell/core/routes.ts`.

## The launch prompt

`newPrototypeText()` is the only instruction guaranteed to
reach a prototype agent — it is always in its first user turn, unlike a
`CLAUDE.md` it may never open. So it carries the rules that decide whether the
result is an original design: **write to `~/.singularity/apps/prototypes/` and commit
nothing, edit the blank template in place, never open another prototype's
folder, never read `plugins/`**, keep the folder self-contained — and
**declare variants as options instead of building a switcher into the page**
(`OPTIONS_RULE`, `launch-rules.ts`; the owner chose this instruction, not a
check, as the guard).
Keep it tight and let `prototypes/CLAUDE.md` hold the rest — but do not let
it drift back into "follow the shape of the existing mocks", which is what
it said before and is why every prototype looked alike.

It names the folder as a PATH, never as a name. It is a minted id, and
`` `proto-1786877040-w2vi` `` written as a name reads like something the agent
should live up to. What the prototype is called is its `<title>` — which
`newPrototypeText()` asks the agent to write, because until it does, the card
reads the template's own "Untitled prototype".

## New prototype mints before it launches

The New prototype button does not ask the agent to create anything. Its
`getRequest` is `async`: it `POST`s `createPrototype`, gets back a minted id, and
only then builds the prompt naming that folder. `getRequest` is awaited before
the conversation is created (`launch-control.tsx`), so this needs no change to
the launch primitive — and it is what makes the ordering safe.

A failed mint must not become a launch: `mintPrototypeFolder()` toasts the error
and re-throws, and that rejection is what stops `createConversation` from ever
running. So no agent is handed a prompt naming a folder that is not there. The
rejection also escapes to `window.onunhandledrejection`, which files a crash
report — deliberate, and why the toast is not a `catch` that ends there.

Accepted consequence: a card appears in the gallery the moment the button is
clicked, reading "Untitled prototype" until the agent's first save. It is
honest — the prototype does exist — and it self-corrects.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Prototypes gallery list pane — one card per prototype over its rendered preview, on the prototype viewer's grid, with a Recently edited list; grouped by its tag as nested sections along the prototypes' tag tree (or by status: Pinned / In progress / Done), with a pin and a Done circle on every card and row (hover actions that stay shown while set; also in the detail pane's header, beside the tag chip opening the shared tag picker), an undoable Delete on every card and in the detail header (deletedAt in the prototype's state — the folder stays), and a Trash view (its own source in the same view bar) listing the deleted ones with Restore — plus New prototype, which mints the folder before launching the agent that designs it.
- Web:
  - Slots:
    - `prototypesGalleryPane.Actions`
    - `sources`
    - `PrototypeCardActions`
    - `trash-actions`
  - Slot contributors:
    - `prototypesGalleryPane.Actions` ← `primitives.pane`
    - `sources` ← `apps.prototypes.gallery`
    - `PrototypeCardActions` ← `apps.prototypes.gallery`
    - `PrototypeCardActions` ← `apps.prototypes.present`
    - `trash-actions` ← `apps.prototypes.gallery`
  - Contributes:
    - `Pane.Register` "prototypes-gallery"
    - `sources` "Prototypes" → `GallerySource`
    - `sources` "Trash" → `TrashSource`
    - `prototypeDetailPane.Actions` "tag" → `TagHeaderAction`
    - `prototypeDetailPane.Actions` "pin" → `PinHeaderAction`
    - `prototypeDetailPane.Actions` "done" → `DoneHeaderAction`
    - `prototypeDetailPane.Actions` "delete" → `DeleteHeaderAction`
    - `PrototypeCardActions` "pin" → `PinCardAction`
    - `PrototypeCardActions` "done" → `DoneCardAction`
    - `PrototypeCardActions` "delete" → `DeleteCardAction`
    - `trash-actions` "restore" → `RestoreCardAction`
  - Uses: 40 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×8
    - `apps/prototypes/canvas` ×4
    - `infra/endpoints` ×4
    - `apps/prototypes/state` ×3
    - `primitives/live-state` ×3
    - `primitives/pane` ×3
    - `apps/prototypes/thumbnails` ×2
    - `tag-tree/picker` ×2
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/icon-button.IconButton`
    - `primitives/launch.LaunchAgentPopover`
    - `primitives/loading.Loading`
    - `primitives/relative-time.RelativeTime`
    - `shell/notifications.useToast`
    - `shell/toast.showToast`
    - `tag-tree/engine.useTagTree`
    - `ui/icons.Icon`
  - Exports (types): `PrototypeGalleryRow`
  - Exports (values):
    - `PrototypeCardActions`
    - `prototypesGalleryPane`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --primary-text`
  - Imported by: `apps/prototypes/present`

<!-- AUTOGENERATED:END -->
