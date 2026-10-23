# gallery

The Prototypes app's gallery: the list of every prototype, and New prototype.

- **Gallery pane** (`/prototypes`) — a `DataView` over the live
  `prototypesList` value, with a Gallery view (cards grouped by status) and a
  Recently edited list (`config/apps/prototypes/gallery/prototypes.gallery.jsonc`).
  The pane lies on the viewer's own ground: `PaneChrome`'s `ground` prop takes
  `canvas`' `<CanvasGround>` (the 28px grid under its vignette), which stays put
  while the cards scroll over it. Activating a card pushes the detail pane (the
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

  **The fields** (`web/internal/gallery-fields.tsx`, `galleryFields`) are the
  card's three lines (`partitionCardFields`): the `<title>` (primary), the
  problems count as an `indicator` after it (absent — so omitted — when there
  are none; the problems themselves are listed in the detail pane), the blurb
  as the subtitle, then `modifiedAt` (`schedule` icon, relative time) and
  `versions` (`history` icon, "v12") as tokens. A prototype with no known
  version count has `versions: undefined`, so the token is omitted — never
  "v0". `name` (the minted id, the row key and URL param), `createdAt` and
  `status` are hidden sort / filter / group dimensions.

  **Four values are subscribed here, together** (`useCombinedResources` over
  `useLive(prototypesList)`, `usePrototypeThumbnails()`,
  `useLive(prototypeStatuses)` and `useLive(prototypeVersionCounts)`), and the
  cards wait for all of them. A value is filled by its subscription's first
  answer, asked for when its first subscriber mounts, so subscribing to the
  thumbnails (or counts) down inside a card would put that ask strictly after
  the list had painted — a guaranteed late paint on every load. Side by side
  they are answered in parallel, and the card is right the first time it is
  painted. `joinGalleryRows` maps statuses and counts onto the rows
  (`PrototypeGalleryRow = PrototypeMeta & { done, pinned, versions }`), so
  everything reads one value: the hidden `status` field (the gallery groups by
  it), a muted title on Done cards (`rowTone`), and the card actions.

  `status` is an enum of three ("Pinned" / "In progress" / "Done") rather than
  the `pinned` / `done` bools it projects: the field is read as SECTION HEADINGS
  and as filter values, where the bool type's own "No" / "Yes" says nothing
  about what it is No of. A pin outranks Done (a pinned, finished prototype
  sits under Pinned).

  **Pin / Done / Open in a new tab — the card actions** (`PrototypeCardActions`,
  the same set on a gallery card and a list row). Pin (`PinCardAction`) and the
  Done circle (`DoneCardAction`) are `revealed` (hover) actions with
  `useActive` (`usePinnedActive` / `useDoneActive`, a plain read of the joined
  row): a set state stays painted at rest, the rest appear on hover. Both
  write through `useSetPrototypeStatus` (`set-status.ts`) — one status record
  `{ done, pinned }`, a change setting one field and never clobbering the
  other — and their click never opens the card. Open in a new tab is
  contributed by `present` (the live present page). The canvas header carries
  the same two toggles — `PinHeaderAction` / `DoneHeaderAction`, contributions
  to `prototypeDetailPane.Actions` — with fixed labels so toggling never
  changes the header's width.

The detail pane itself — the canvas of frames, its version steppers, option
picks, size and zoom — is the sibling `canvas` plugin. The gallery depends on
it to put its pin / Done toggles in the canvas's header and for the ground it
sits on (`CanvasGround`); the routes of both panes
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Prototypes gallery list pane — one card per prototype over its rendered preview, on the prototype viewer's grid, with a Recently edited list; grouped (Pinned / In progress / Done) and filterable by a pin and a Done circle on every card and row (hover actions that stay shown while set; also in the detail pane's header), a confirmed Delete on every card and in the detail header (the folder moves to the data dir's _trash/) — plus New prototype, which mints the folder before launching the agent that designs it.
- Web:
  - Slots:
    - `prototypesGalleryPane.Actions`
    - `PrototypeCardActions`
  - Slot contributors:
    - `prototypesGalleryPane.Actions` ← `primitives.pane`
    - `PrototypeCardActions` ← `apps.prototypes.gallery`
    - `PrototypeCardActions` ← `apps.prototypes.present`
  - Contributes:
    - `Pane.Register` "prototypes-gallery"
    - `prototypeDetailPane.Actions` "pin" → `PinHeaderAction`
    - `prototypeDetailPane.Actions` "done" → `DoneHeaderAction`
    - `prototypeDetailPane.Actions` "delete" → `DeleteHeaderAction`
    - `PrototypeCardActions` "pin" → `PinCardAction`
    - `PrototypeCardActions` "done" → `DoneCardAction`
    - `PrototypeCardActions` "delete" → `DeleteCardAction`
  - Uses: 29 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/prototypes/canvas` ×4
    - `infra/endpoints` ×4
    - `primitives/data-view` ×3
    - `primitives/live-state` ×3
    - `primitives/pane` ×3
    - `apps/prototypes/thumbnails` ×2
    - `primitives/css/ui-kit` ×2
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/icon-button.IconButton`
    - `primitives/launch.LaunchAgentPopover`
    - `primitives/overlay/imperative-dialog/confirm.confirmDialog`
    - `primitives/relative-time.RelativeTime`
    - `shell/notifications.useToast`
    - `ui/icons.Icon`
  - Exports (types): `PrototypeGalleryRow`
  - Exports (values):
    - `mintPrototypeFolder`
    - `newPrototypePrompt`
    - `PrototypeCardActions`
    - `prototypesGalleryPane`
    - `useSetPrototypeStatus`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --primary-text`
  - Imported by:
    - `apps/home/app-cards`
    - `apps/prototypes/present`

<!-- AUTOGENERATED:END -->
