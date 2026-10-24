# Conversation artifacts popover

Date: 2026-09-19
Category: conversations (conversation-view)

## Context

A conversation produces things that outlive it — a prototype it designed, a page it
wrote, a research doc, the screenshots it took, the skills it loaded. Today the only
way back to any of them is to scroll the transcript and find the turn where it
appeared. The conversation toolbar has a button for edited *files* (`docs-button`,
`commits-graph`), but nothing that answers "what did this conversation produce, and
where is it now?".

This adds one toolbar button, **Artifacts**, whose popover lists everything the
conversation made, changed or looked at, grouped by kind, and opens each one in its
existing surface. The set of kinds is open: a future kind (files changed, tasks filed,
deploys, …) is one new sub-plugin and no edit to the popover.

Design explored in prototype `proto-1789731211-jeis` (options `surface=popover`,
`icons=on`, `color=off`, which is the look this plan builds).

## Where the data comes from

**No new server resource, no transcript re-scan.** The conversation view already
subscribes to `jsonlEventsResource`
(`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core`), a
`push` resource carrying the whole parsed event array for the open conversation.
`event-counter` already reads it from the action bar
(`.../jsonl-viewer/plugins/event-counter/web/components/event-counter.tsx`) — the
artifacts button does the same and joins the existing subscription.

Artifacts are then derived **client-side** from that array, in a `useMemo` keyed on it.
Each event is a `JsonlEvent` (`transcript-watcher/core/protocol.ts`): a `tool-call`
carries `name` + raw `input` + `result`, and text events carry their text. That is
everything the extractors need.

Known limitation to state in the UI copy nowhere and in this doc only: work done inside
a **subagent** runs in its own transcript, which is not part of this conversation's
chain, so a prototype a subagent edited is only caught if its id also appears in the
parent's tool inputs (it usually does, in the `Agent` prompt).

## Shape

New plugin `plugins/conversations/plugins/conversation-view/plugins/artifacts/`:

- `core/` — the contract:
  ```ts
  type Relation = "created" | "edited" | "referenced";   // strongest wins on merge
  type ArtifactHit  = { kind: string; key: string; relation: Relation; at: string };
  type ArtifactItem = { key: string; relation: Relation; firstAt: string; lastAt: string };
  ```
- `web/` — the slot, the aggregation, the button and the popover:
  ```ts
  ConversationArtifacts.Kind({
    id: "prototype",
    label: "Prototypes",
    extract: (event: JsonlEvent) => ArtifactHit[],   // PURE, no hooks — this is what the host calls
    Section: PrototypeSection,                       // renders THIS kind's items, its own layout
  })
  ```
  The host walks the contributions in slot order, runs every `extract` over the event
  array, merges hits by `(kind, key)` keeping the strongest relation, and renders one
  `<Section items={…}/>` per kind that has any. The host never names a kind: the total
  count on the button, the section headings and the order all come from the registry
  (slot order, so the reorder primitive makes it user-orderable for free).

  Splitting `extract` (pure) from `Section` (a component) is what makes both halves
  possible: the count must exist before any section renders, and each kind's title
  lookups are hooks that must live inside that kind's own component.

Each kind is a sub-plugin under `artifacts/plugins/<kind>/web/`, owning its extractor,
its section layout and where a click goes.

## The five kinds

| Kind | Extract from | Relation | Opens |
|---|---|---|---|
| **prototype** | any `proto-<ts>-<xxxx>` id in a tool input or in text | `prototype new` in a Bash command → created; `Write`/`Edit` inside the prototype folder → edited; else referenced | `prototypeDetailPane`, `{ name: id }`, `mode: "push"` |
| **page** | tool names matching `/edit_page$/`, `/write_agent_note$/`, `/read_page$/`; key = `page_id` from the apply report, else `block_id` | write/edit → edited (created when the input mints an `<agent-page>`); read → referenced | `pageDetailPane`, `{ pageId }` |
| **research** | `Read`/`Write`/`Edit` `file_path` matching `research/*.md` (and `sidequests/*/research/*.md`) | Write → created, Edit → edited, Read → referenced | `filePeekPane`, `{ worktree: attemptId, filePath }` |
| **screenshot** | `Read` on an image path | created (the agent looked at it) | `ImageGallery` + `ViewerThumbnail` — the full-window image viewer, not a pane |
| **skill** | `Skill` tool calls, key = `input.skill` | referenced | `filePeekPane` on `.claude/skills/<name>/SKILL.md`; a packaged skill (`plugin:skill`) has no file, so its chip is inert with a tooltip saying so |

Two helpers exist today inside one consumer and must move so both callers share one
definition — the fix is at the "no second authority" rung, not a copy:

- the prototype-id scan (`touchedPrototypeIds` + `stringLeaves`, today in
  `plugins/apps/plugins/prototypes/plugins/checkpoints/server/internal/turn.ts`, over
  `PROTOTYPE_ID_RE` from `.../prototypes/plugins/files/core/id.ts`) → lift into
  prototypes `core/`, and have the checkpoint job and the new extractor both call it.
- the screenshot `src` builder (`/api/code/:worktree/image?path=…`, today inline in
  `.../tool-call/plugins/read/web/components/read-image-view.tsx`) → move to
  `plugins/code-explorer/plugins/code-api/core`, where the rest of the `/api/code/*`
  contracts already live.

Titles are resolved per kind, inside its section: prototypes from the prototypes list
resource (the gallery already renders titles for ids), pages the way `PageRefChip`
already does, research docs and screenshots from the path's basename, skills from the
skill name itself.

## The popover

- Button contributed with `Conversation.ActionBar({ id: "artifacts", component: ArtifactsButton })`
  (slot owner: `.../conversation-view/plugins/action-bar/web`). Icon plus a count, ghost
  when closed, disabled at zero — same states as `docs-button`.
- `InlinePopover` (`primitives/overlay/popover/web`), `align="end"`, ~320px, capped
  height with the list scrolling — the `TaskDraftPopover` pattern.
- Per the prototype: one line per item, the kind's icon at the left, **no per-kind
  colour** (icons and text take the normal muted/foreground tokens), a small filled dot
  for *created* and a half dot for *edited*, nothing for *referenced* (whose title is
  muted). Section heading is a caption-size uppercase label. Hovering an item shows its
  path/id and the turn it came from.
- **Per-kind layouts** (the chosen option): rows for prototypes / pages / research, a
  4-up thumbnail grid for screenshots, name chips for skills. Each section is its own
  component, so `data-view/no-adhoc-row-list` will fire on the row-mapping ones — annotate
  each with `// eslint-disable-next-line data-view/no-adhoc-row-list -- popover chrome:
  each artifact kind renders its own layout (rows / thumbnails / chips)`.
- Clicking a row calls `useOpenPane()` with `mode: "push"`, so the preview lands as a
  column beside the conversation, and closes the popover. Screenshots open the image
  viewer overlay instead.
- Not in v1: the "open as pane" escape hatch, search, and grouping by turn — all explored
  in the prototype, none needed before the popover is in daily use.

## Files

- New: `plugins/conversations/plugins/conversation-view/plugins/artifacts/{core,web}/` —
  contract, `ConversationArtifacts.Kind` slot, aggregation hook (`useConversationArtifacts`),
  `ArtifactsButton`, popover body, shared row/section chrome.
- New: `artifacts/plugins/{prototype,page,research,screenshot,skill}/web/` — one extractor
  + section each, with an `extract.test.ts` beside it.
- Edited: prototypes `core/` (lift the id scan) and its checkpoint job (call it);
  `code-explorer/plugins/code-api/core` (image src builder) and `read-image-view.tsx`
  (call it).
- No server changes, no DB migration, no new endpoint.

## Verification

1. `./equin build` (background), then open a conversation at
   `http://<worktree>.localhost:9000`.
2. Drive it: `./equin run plugins/conversations/plugins/conversation-view/plugins/artifacts/e2e/artifacts-popover.ts`
   — a new e2e script that opens a conversation known to have artifacts, clicks the
   Artifacts button, asserts the section headings and the count on the button, clicks the
   first prototype row and asserts a prototype pane opened beside the chat.
3. `./equin test plugins/conversations/plugins/conversation-view/plugins/artifacts`
   — the extractors are pure functions over `JsonlEvent[]`: one fixture per kind, plus a
   merge case (same prototype referenced then edited → `edited`, one row).
4. Check the empty case by hand: a conversation that touched nothing shows a disabled
   button with no count.
5. `./equin check` for boundaries, lint and the plugin docs being in sync.
