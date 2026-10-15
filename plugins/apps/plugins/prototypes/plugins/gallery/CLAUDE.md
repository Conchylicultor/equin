# gallery

The Prototypes app's gallery: the list of every prototype, and New prototype.

- **Gallery pane** (`/prototypes`, no chrome) — a `DataView` gallery over the
  live `prototypesList` value. Each card shows the prototype's `<title>` + blurb
  over its rendered screenshot (`thumbnails`' `<PrototypeThumbnail>`; `name`
  stays the row key and the URL param — it is the directory name, which is a
  minted id); activating one pushes the detail pane (the `canvas` plugin). A
  "New prototype" button opens a `LaunchAgentPopover` that mints first (see below).

  `CoverSwatch` — the id-tinted gradient — stays here as the stand-in the
  thumbnail falls back to before its picture exists, or when rendering it
  failed. This pane owns the stand-in; `thumbnails` owns the picture.

  **Both values are subscribed here, together** (`useCombinedResources` over
  `useLive(prototypesList)` + `usePrototypeThumbnails()`), and the cards wait
  for both. A value is filled by its subscription's first answer, asked for
  when its first subscriber mounts, so subscribing to the thumbnails down
  inside a card would put that ask strictly after the list had painted — a
  guaranteed swatch-then-screenshot swap on every load. Side by side they are
  answered in parallel, and the cover is right the first time it is painted.
  **Done.** A third resource joins them: `files`' `prototypes.statuses`. The
  gallery maps it onto the rows (`PrototypeGalleryRow = PrototypeMeta & { done, pinned }`)
  so everything reads one value: a hidden `status` field (the gallery groups by
  it by default — see `config/apps/prototypes/gallery/prototypes.gallery.jsonc`
  — and can be filtered on it; no card body cell, the checkbox already shows
  it), a muted title on Done cards (`rowTone`), and the Done checkbox, which is
  a `persistent` contribution to `PrototypeCardActions` (painted at rest in the
  card footer; its click never opens the card). The canvas's header has the
  same toggle — `DoneHeaderAction` (`done-toggle.tsx`), a contribution to the
  canvas's `prototypeDetailPane.Actions` — with a fixed "Done" label so ticking
  it never changes the header's width.

  `status` is an enum of three ("Pinned" / "In progress" / "Done") rather than
  the `pinned` / `done` bools it projects: the field is read as SECTION HEADINGS
  and as filter values, where the bool type's own "No" / "Yes" says nothing
  about what it is No of. A pin outranks Done (a pinned, finished prototype
  sits under Pinned).

  **Pinned.** The second field of the same status record (`{ done, pinned }`;
  a change sets one field and never clobbers the other). A pin icon beside the
  Done checkbox on every card (`PinCardAction`, `persistent`), and beside the
  Done toggle in the canvas header (`PinHeaderAction`); both write through
  `useSetPrototypeStatus` (`set-status.ts`).

The detail pane itself — the canvas of frames, its version steppers, option
picks, size and zoom — is the sibling `canvas` plugin. The gallery depends on
it only to put its Done toggle in the canvas's header; the routes of both panes
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

- Description: Prototypes gallery list pane — one card per prototype over its rendered preview, grouped (Pinned / In progress / Done) and filterable by a pin and a Done checkbox on every card (and in the detail pane's header) — plus New prototype, which mints the folder before launching the agent that designs it.
- Web:
  - Slots:
    - `prototypesGalleryPane.Actions`
    - `PrototypeCardActions`
  - Slot contributors:
    - `prototypesGalleryPane.Actions` ← `primitives.pane`
    - `PrototypeCardActions` ← `apps.prototypes.gallery`
  - Contributes:
    - `Pane.Register` "prototypes-gallery"
    - `prototypeDetailPane.Actions` "pin" → `PinHeaderAction`
    - `prototypeDetailPane.Actions` "done" → `DoneHeaderAction`
    - `PrototypeCardActions` "pin" → `PinCardAction`
    - `PrototypeCardActions` "done" → `DoneCardAction`
  - Uses: 28 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×4
    - `infra/endpoints` ×3
    - `primitives/live-state` ×3
    - `primitives/pane` ×3
    - `apps/prototypes/canvas` ×2
    - `apps/prototypes/thumbnails` ×2
    - `primitives/css/ui-kit` ×2
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/pin.Pin`
    - `primitives/icon-button.IconButton`
    - `primitives/launch.LaunchAgentPopover`
    - `primitives/relative-time.RelativeTime`
    - `shell/notifications.toast`
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
    - `ui/tokens/color-palette --success`
    - `ui/tokens/shape --spacing`
  - Imported by: `apps/home/app-cards`

<!-- AUTOGENERATED:END -->
