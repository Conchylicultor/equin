# artifacts

A conversation makes things that outlive it — a prototype it designed, a page it
wrote, a research doc, the screenshots it took, the skills it loaded. This is the
toolbar button that lists them and opens each one where it already lives.

## Where the data comes from

Nothing new on the server, and no second pass over the transcript. The
conversation view already subscribes to the parsed event array
(`useLive(jsonlEvents, { id })`); `useConversationArtifacts` joins that subscription and
derives everything here, in a `useMemo` over the array. So the cost of the
button is one pass per new turn, not a query.

Known gap: work an agent delegated to a **subagent** happens in its own
transcript, which is not part of this one. A prototype a subagent edited only
shows up if its id also appears in the parent's tool inputs — which it usually
does, in the `Agent` prompt.

## Adding a kind

A kind is one sub-plugin under `plugins/<kind>/web/`, contributing to
`ConversationArtifacts.Kind`:

```ts
ConversationArtifacts.Kind({
  id: "prototype",
  label: "Prototypes",
  icon: MdDesktopWindows,
  origin: "produced",      // or "consumed" — see "What the closed button shows"
  extract: (event) => …,   // PURE — runs per event, before anything renders
  Section: PrototypeSection,
});
```

The two halves exist for two different reasons, and neither can do the other's
job:

- **`extract` is a pure function**, not a component, because the count on the
  closed button has to exist before any section is mounted. It may not call
  hooks or fetch. It gets one `JsonlEvent` and returns a hit per sighting, one
  per `(kind, key)` it saw — the host folds repeats together, keeping the
  strongest relation (`created` > `edited` > `referenced`) and the first/last
  instant. An extractor that reports under another kind's `id` **throws**: those
  rows would otherwise land in a section that never looked for them.
- **`Section` is the component**, because a kind's titles need a lookup (the
  prototypes list, a page's name) and a lookup is a hook. It is mounted only
  while the popover is open, and only when the kind found something.

### What the closed button shows

The closed button says **what the conversation made**, at a glance: one glyph
per kind it created or edited something of, then a single number for all of
them — "prototypes, pages and research: 4" without opening anything. The
per-kind split is in the tooltip. This is where a conversation's design docs
surface; there is no separate Docs button.

Two filters decide what reaches the button, and neither touches the panel:

- **The kind's `origin`**, required so a new kind decides rather than cluttering
  the button by existing:
  - `"produced"` — prototypes, pages, research docs. These show.
  - `"consumed"` — the pictures the agent read, the skills it loaded. These get
    their own section like any other and never reach the button. A turn that
    took four screenshots on the way to one page made one thing, and a button
    covered in cameras and bolts would describe the agent's route rather than
    the user's work.
- **The item's relation**: only `created` and `edited` count. A research doc the
  agent only read is listed in the panel (muted, no mark) but is not something
  the conversation made.

So the panel normally lists more rows than the button counts. That is why the
panel's own heading carries no number — two numbers an inch apart under the
same word read as a contradiction — and why the button's tooltip says "made or
changed". A conversation that made nothing shows the generic glyph alone and
still opens the panel, rather than a "0" its own rows contradict. The glyphs
follow the slot's reorder config (and its hidden kinds), so the button and the
panel's sections cannot disagree on order.

### What a section should render

Reuse the shared chrome so five kinds read as one list: `ArtifactRow` for a
plain line (the kind's glyph, the title, the relation mark), `RelationMarker`
alone for a bespoke layout (a thumbnail grid, a chip strip). The section heading
is drawn by the host from the kind's `label` — a section renders only what goes
under it.

**`ArtifactRow` IS a `Row`**, so a kind that hand-rolls a line out of `Line` +
an icon + a `<Text>` is the one that drifts: `Row` declares the type rung (a
variant-less `<Text>` in a popover inherits the document root — 16px), sizes a
bare glyph from that same rung, and owns the focus ring and padding. The row
adds only `size="sm"` (picker density, one step under the panel's own header),
`hover="muted"` (the popover tint — `Row`'s default accent reads as a selection
here) and the dismissal below. The row's `size` and the title's `Text variant`
are one decision: the glyph is sized from the ROW's rung, so a title on a
different one is back out of step.

Everything in the panel shares one left edge, and each band pays for it
separately: the header says `px-md` outright; inside the body stack's `p-xs`, a
heading and a bespoke section say `px-sm`, which is what a row's `p-row` already
is. Move one and the others have to follow.

The relation mark goes in the row BODY, never in `Row`'s `actions` slot: it is
state to read, not a control to press, and `actions` is hover-revealed.

Controls do go there: `ArtifactRow`'s `actions` prop is `Row`'s hover-revealed
cluster. A prototype row uses it for **Open in a new tab** — the prototype alone,
at its own Prototypes-app URL, in a new browser tab (`openInBrowserTab`), where
⌘-click on the row opens the conversation-with-mock route instead.

`ArtifactRow` takes an `activation` (`openPane.to(…)` — a link, so ⌘/middle-click
opens a browser tab) and dismisses the popover itself when its row is activated,
so a kind cannot ship a row that navigates and leaves the panel over what it
opened. A bespoke layout that opens something wraps its link in
`afterOpen(link, useCloseArtifacts())` for the same effect.

**The glyphs come from the mock** (`proto-1789731211-jeis`): assorted shapes on
the button, a flask for research, a camera for screenshots, a bolt for skills.

Two kinds outrank the mock, and the rule is where the row GOES: a prototype row
opens the Prototypes app and a page row opens Pages, so each wears that app's
own rail icon rather than the mock's drawing of one — you should land in the
thing whose mark you just clicked. Research has no app of its own (a row opens
the file-peek pane), so it takes the mock's flask, and deliberately not a page
glyph: here — and on the closed button — it sits directly beside Pages, and two
document glyphs in a row read as one kind split in two.

**No per-kind colour.** Every glyph, title and mark takes the normal
muted/foreground ink; what a conversation *did* is a whole dot (made it), half a
dot (changed it) or nothing (only looked at it, and the title goes muted). A
colour key is a thing to learn; this is a thing to read.

## The host names no kind

The popover walks the registry in slot order — so the reorder primitive makes
the sections user-orderable for free — reads each contribution's `label`, and
hands it its own items. The count, the headings and the order all come from the
registry. Adding "files changed" or "tasks filed" is one folder and no edit
here.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Conversation toolbar button listing everything the conversation made, changed or looked at. Owns the ConversationArtifacts.Kind registry each kind of artifact contributes to (a pure extractor over transcript events plus its own section), the aggregation over the already-open jsonl-events subscription, the popover, and the shared row / section / relation-mark chrome every kind renders through. Names no kind.
- Web:
  - Slots: `ConversationArtifacts.Kind`
  - Slot contributors:
    - `ConversationArtifacts.Kind` ← `conversations.conversation-view.artifacts.page`
    - `ConversationArtifacts.Kind` ← `conversations.conversation-view.artifacts.prototype`
    - `ConversationArtifacts.Kind` ← `conversations.conversation-view.artifacts.research`
    - `ConversationArtifacts.Kind` ← `conversations.conversation-view.artifacts.screenshot`
    - `ConversationArtifacts.Kind` ← `conversations.conversation-view.artifacts.skill`
    - `ConversationArtifacts.Kind` ← `debug.browser-recordings`
  - Contributes: `Conversation.ActionBar` → `ArtifactsButton`
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×3
    - `primitives/css/text` ×2
    - `primitives/css/ui-kit` ×2
    - `reorder` ×2
    - `conversations/conversation-view/action-bar.Conversation`
    - `conversations/conversation-view.conversationPane`
    - `network/live.useLive`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/link-gesture.activationProps`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/relative-time.formatRelativeTime`
    - `primitives/slot-render.defineRenderSlot`
    - `ui/icons.Icon`
  - Exports (types):
    - `ArtifactKind`
    - `ArtifactRowProps`
    - `ConversationArtifactsResult`
  - Exports (values):
    - `ArtifactRow`
    - `ArtifactSection`
    - `ConversationArtifacts`
    - `RelationMarker`
    - `useCloseArtifacts`
    - `useConversationArtifacts`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --pad-row-x`
    - `ui/tokens/density --pad-row-y`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by:
    - `conversations/conversation-view/artifacts/page`
    - `conversations/conversation-view/artifacts/prototype`
    - `conversations/conversation-view/artifacts/research`
    - `conversations/conversation-view/artifacts/screenshot`
    - `conversations/conversation-view/artifacts/skill`
    - `debug/browser-recordings`
- Core:
  - Exports (types):
    - `ArtifactHit`
    - `ArtifactItem`
    - `Relation`
  - Exports (values):
    - `mergeHits`
    - `RELATION_LABEL`
    - `strongestRelation`
- Sub-plugins:
  - **`page`** — Singularity pages as a conversation artifact: every page the transcript's edit_page / write_agent_note / read_page calls acted on, listed as a row that opens the page beside the chat — or, for a…
  - **`prototype`** — Prototypes as a conversation artifact: every `proto-…` id the transcript names — in a tool input or in the agent's or user's own words — listed as a row that opens the mock beside the chat. A…
  - **`research`** — Research docs as a conversation artifact: the design docs it wrote, changed or read (research/*.md, and a sidequest's own), listed as rows that open in the file-peek pane beside the conversation.
  - **`screenshot`** — Screenshots as a conversation artifact: every picture the agent read, shown as a four-up thumbnail grid that is one ← / → set in the full-window image viewer.
  - **`skill`** — Skills as a conversation artifact: every skill the agent loaded, as a wrapped strip of monospace name chips — a repo skill opens its SKILL.md in the file-peek pane, a plugin-packaged skill has no…

<!-- AUTOGENERATED:END -->
