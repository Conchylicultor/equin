# jsonl-viewer

## `jsonl-events`: paged, newest first — the page never holds the whole transcript

`jsonlEvents` (`core/protocol.ts`) is a key-range-paged `liveValue` (query
`{ id }`): rows `{ id, seq, event }`, newest first, 200 per page. A
conversation opens on its latest events; `TranscriptView` loads older pages as
the reader scrolls to the top (`older`, a top sentinel) and keeps the reader in
place (`KeepAnchorAcross`). A change ships a keyed delta — an appended line is
one row, a tool result landing an upsert of its call — never the array. Read it
through `useTranscriptWindow(conversationId)` (events oldest first, row ids, the
window's `firstSeq`, the paging handles); `jsonlEvents.meta` answers what only
the whole transcript knows (count, the first assistant event's seq).

**A reader of the whole conversation never folds the window.** A tail window is
closed under "after" (every event after a loaded one is loaded), so a forward
scan from a drawn event is complete (AskUserQuestion finding its answer); a
whole-conversation fact is a small server-derived value instead:
`serveTranscriptValue(value, derive)` (server) runs `derive` over every event in
memory once per change and pushes only when the result changed;
`useWholeTranscript(value, derive)` (web) reads it — or derives it locally when
the view draws a whole transcript (a sub-agent's pane). Owners: the outline's
turns, the task aggregate, background shells, sub-agent facts, artifacts. A
stat "as of the row on screen" is a resumable fold (`transcript-stats`'
`TranscriptFold` + `serveTranscriptFold` + `useTranscriptFold`): the server folds
everything before the window, the page continues over the loaded rows. One
tool call by id, from outside the transcript, is `transcriptToolCall`.

**One watch, one memo, per conversation.** Every value served from a
conversation's events (the pages, the meta, every derived value) reads
`conversationEvents(id)` and watches through `watchConversationEvents`
(`server/internal/conversation-events.ts`): a refcounted hub over ONE
`TranscriptSource.watch`, whose snapshot primes the shared `createSignedMemo`
(`jsonl-events-cache.ts`) before anyone is notified, so every recompute reads
memory. The memo's signature and value come from one authority (the host's
`TranscriptSource`), so push vs on-demand stays a delivery choice — see
`research/2026-07-10-conversations-jsonl-events-shared-authority.md`. The
desktop host reads only the bytes appended since its last read
(`transcript-watcher`'s `readChain`).

**Images ride by reference.** An event carries `TranscriptImage { key, mime }`;
the page loads the bytes from `transcriptImageUrl(key)` (`GET
/api/transcript-images/:key`, cached immutably — the key names its line by
offset and uuid, or its file by mtime and size, and a changed source is a 410,
never other bytes). Design and measurements:
`research/2026-10-20-conversations-transcript-delivery-phase2.md`.

## Rules for `EventRenderer` contributors

**Never use `uppercase` (all-caps) styling on labels.** Eyebrow labels rendered
all-caps — `THINKING`, `QUEUED`, `SENT TO AGENT`, status badges, section headers —
create visual distraction across the transcript. Render labels in their natural
case (`Thinking`, `Queued`). This applies to every row, badge, and section header
in the jsonl-viewer (and conversation-view) subtree. Note: `capitalize` for
title-casing a model name (`sonnet` → `Sonnet`) is fine — only `uppercase` is
banned.

**Label copy is sentence case, not Title Case.** `Session context`, `Deferred
tools`, `Skills available` — capitalise the first word and proper nouns, nothing
else. Title Case (`Skills Available`, `Task Reminder`) reads as a heading in a
document rather than as a line in a conversation, and a transcript scrolled past
at speed is a column of such labels: mixed casing across neighbouring rows is the
thing the reader notices instead of the content. The same applies to a card's
`note` and to an `EventLine`'s label.

**A card's `note` is a middot-led suffix naming what it counted** — `· 3 files`,
`· 26 skills`, `· +34`, `· no changes` — never a bare parenthesised number. The
collapsed rows stack into one column, and the reader is scanning that column for
which row to open: `(6)` makes them open the row to find out six of what, while
`· 6 agents` answers it in place.

**Never render an event's timestamp inline in your row.** Every event is wrapped
by `EventRow`, which already contributes the shared `TimestampAction`
(`JsonlRowActions.Item` id `"timestamp"`) — a hover-only chip showing the
relative time, with the absolute time in its `title` tooltip. Adding your own
`<Timestamp at={e.at} />` produces a redundant always-visible timestamp (and a
double timestamp on hover). The timestamp is universal and hover-only by design;
do not duplicate it in `system`, `task-notification`, `meta-prompt`,
`user-image`, or any new renderer.

**Never hand-place an investigate or raw-JSON affordance in a fallback
renderer.** Both are `JsonlRowActions.Item` contributions, and the investigate
one gates itself on `useDispatchOutcome()?.matched === false` — so it already
appears on *every* row whose nearest dispatch fell back (unhandled event kind,
unhandled tool name, unhandled attachment subtype), including fallbacks written
later. Passing one as your card's `trailing` renders it twice; the strip's copy
is the canonical one. Write the fallback's own content and nothing else.

There is also **no contributed renderer for `kind: "unknown"`** any more. The
parser-level fallback and the dispatch-level fallback were the same fact at two
layers, so `kind: "unknown"` now falls through to the `EventRenderer` slot's own
`fallback` (`UnknownEventRow`), which shows the raw payload in a
`CollapsibleCard` and therefore carries the whole action strip. Do not
re-contribute a renderer matching `"unknown"` — that would make the dispatch
report `matched: true` and silently take the investigate action away from the
one row family that most needs it.

**Render an image as a `ViewerThumbnail`** (`primitives/overlay/image-viewer`),
never a hand-rolled expand toggle. `JsonlPane` wraps the rendered events (not the
pending turns or the composer) in one `<ImageGallery>` per pane, so every
thumbnail in a row joins the pane's ← / → set with no wiring.

## Harness context folds behind one rule

Runs of harness-injected context — the session-start burst (instructions,
environment, tool / skill / agent listings…), the re-sends mid-conversation, the
re-injection after a compaction — render as `Session context · N items` /
`Context update · N items` rules (`ContextFold`), closed by default. It is a
**view** step (`useContextRuns` over `useVisibleEvents`' output, the pure
`groupContextRuns`), never a parser fold or a filter: every reader of the event
list still sees every event, and every member still renders as its own
`EventRow` once opened — fallback card and investigate action included.

- **Classification is declared by whoever renders the event**, through
  `JsonlViewer.ContextRole` (`context` starts a fold, `ambient` joins one,
  `conversation` / unanswered breaks one). An attachment subtype registers with
  `attachmentRenderer({ match, component, role })` (attachment/web), which
  emits the renderer and the role together — a new subtype cannot skip the
  decision. An unrendered subtype is `ambient`.
- **A host** (`EventRenderer({ …, hostsContext: true })`) takes the run right
  after its event into its own row: read it with `useHostedContext()` and place
  `<ContextFold>`. A host that never reads it throws in dev. The compaction
  divider is the one host.

## Overlays: get the scroller from `paneScrollScope.useRoot()`

An `Overlay` contribution renders as a SIBLING of the transcript scroller (inside
the pane's `relative isolate` frame), so `findScrollParent` cannot reach it and a
global `document.querySelector("[data-pane-scroll]")` reaches the WRONG one — two
panes can be open on the same conversation, and rows are keyed by `eventKey`
(`user-text:<timestamp>`), which carries no conversation id. `JsonlPane` publishes
its own scroll element into `paneScrollScope` (a `primitives/scope/scoped-store/dom-scope`
scope); ask for it instead of rediscovering it. The read is a `{ attached }` union,
so a query before the scroller mounts cannot be mistaken for "no matching rows".
`data-pane-scroll` stays stamped for e2e scripts, not as a lookup mechanism from
React.

## The row-action strip lives in `plugins/row-actions`

`EventRowActions`, `EventActionProvider`, `RowActionButton`, `rowActionClass`,
`CopyTextAction` and the action slot itself are **not** exported from
`jsonl-viewer/web` — they belong to the `row-actions` sub-plugin, which sits below
`collapsible-card` so card chrome can host the strip without an import cycle.
Contribute an action with `JsonlRowActions.Item({ id, component })` and import the
button helpers from
`@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web`.
See that plugin's `CLAUDE.md`; in particular it must never import `jsonl-viewer/web`
back.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Renders the raw Claude JSONL session log as the conversation's main content. Hosts the JsonlViewer.EventRenderer slot for child plugins to render specific event kinds. Streams a conversation's transcript as structured events via the paged jsonl-events resource (newest first; a change ships the rows it touched), read from the host's TranscriptSource (Claude's JSONL session log on the desktop), and serves its images by key.
- Web:
  - Slots:
    - `JsonlViewer.EventRenderer`
    - `JsonlViewer.PendingPrompt`
    - `JsonlViewer.EventFilter`
    - `JsonlViewer.ContextRole`
    - `JsonlViewer.Overlay`
    - `JsonlViewer.TranscriptEnd`
  - Slot contributors: 57 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `JsonlViewer.ContextRole` ×31
    - `JsonlViewer.EventRenderer` ×18
    - `JsonlViewer.Overlay` ×4
    - `JsonlViewer.EventFilter` ×2
    - `JsonlViewer.PendingPrompt` ← `conversations.question-relay`
    - `JsonlViewer.TranscriptEnd` ← `tasks.outcome-report`
  - Contributes:
    - `JsonlRowActions.Item` "timestamp" → `TimestampAction`
    - `JsonlRowActions.Item` "raw-json" → `RawJsonAction`
  - Uses: 53 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×7
    - `primitives/dom/auto-scroll` ×5
    - `conversations/conversation-view/pending-turn` ×4
    - `primitives/collapsible` ×4
    - `conversations/conversation-view/jsonl-viewer/row-actions` ×3
    - `primitives/css/ui-kit` ×2
    - `primitives/css/working-dots` ×2
    - `primitives/relative-time` ×2
    - `primitives/slot-render` ×2
    - `conversations/conversation-view/jsonl-viewer/collapsible-card.CollapsibleCard`
    - `network/live.useLive`
    - `primitives/css/center.Center`
    - `primitives/css/fill.Fill`
    - `primitives/css/grow.growClass`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/text.Text`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/in-view.useInView`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/overlay/image-viewer.ImageGallery`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/row-actions.rowActionsAnchor`
    - `primitives/scope/dom-scope.defineDomScope`
    - `primitives/scope/surface-id.useSurfaceTabId`
    - `ui/icons.Icon`
  - Exports (types):
    - `ContextMember`
    - `ContextRole`
    - `ContextRoleContribution`
    - `EventFilterContribution`
    - `EventRendererMeta`
    - `OverlayContribution`
    - `SectionExpand`
    - `TranscriptEvents`
    - `TranscriptOlder`
    - `TranscriptSubject`
    - `TranscriptViewProps`
    - `TranscriptWindow`
  - Exports (values):
    - `ContextFold`
    - `EventLine`
    - `formatTime`
    - `formatTokenCount`
    - `JsonlPane`
    - `JsonlViewer`
    - `paneScrollScope`
    - `Timestamp`
    - `TranscriptView`
    - `useBlockWriting`
    - `useHostedContext`
    - `useJsonlConversationId`
    - `useRowMarkdown`
    - `useSectionExpand`
    - `useStreamingRow`
    - `useTranscriptDrawn`
    - `useTranscriptEvents`
    - `useTranscriptSubject`
    - `useTranscriptWindow`
    - `useVisibleEvents`
    - `useWholeTranscript`
- Server:
  - Contributes:
    - `resource.declare` "jsonl-events"
    - `resource.declare` "jsonl-events.prompts"
    - `resource.declare` "jsonl-events.tool-call"
    - `resource.declare` "jsonl-events:meta"
  - Uses:
    - `conversations/transcript-source.TranscriptImageKeyError`
    - `conversations/transcript-source.TranscriptSource`
    - `infra/git/git-read-cache.createSignedMemo`
    - `network/live.serveValue`
    - `network/live.sliceRange`
  - Exports (values):
    - `conversationEvents`
    - `conversationEventsSignature`
    - `serveTranscriptValue`
    - `watchConversationEvents`
  - Resources:
    - `jsonl-events` (keyed, window, notified)
    - `jsonl-events:meta` (push, notified)
    - `jsonl-events.tool-call` (push, notified)
  - Routes: `GET /api/transcript-images/:key`
- Core:
  - Uses:
    - `conversations/transcript-source.JsonlEventSchema`
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
    - `infra/endpoints.interpolatePath`
    - `network/live.liveValue`
  - Exports (types):
    - `JsonlEventsQuery`
    - `TranscriptEventRow`
    - `TranscriptMeta`
  - Exports (values):
    - `eventKey`
    - `getTranscriptImage`
    - `JSONL_EVENTS_MAX`
    - `JSONL_EVENTS_PAGE`
    - `jsonlEvents`
    - `JsonlEventsQuerySchema`
    - `seqKey`
    - `TranscriptEventRowSchema`
    - `transcriptImageUrl`
    - `TranscriptMetaSchema`
    - `transcriptPrompts`
    - `transcriptToolCall`
- Cross-plugin:
  - Uses tokens: 23 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/type-scale` ×8
    - `ui/tokens/color-palette` ×7
    - `ui/tokens/density` ×5
    - `ui/tokens/shape` ×2
    - `ui/tokens/font-family --font-mono`
  - Imported by: 46 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations` ×44
    - `apps/places/places-map`
    - `tasks/outcome-report`
- Exemptions:
  - Exempts itself from: `no-raw-websocket` — `e2e/no-op-frames.ts` (sanctioned)
- Sub-plugins:
  - **`api-error`** — Renders the CLI's own notice of a failed model request in the JSONL viewer — a usage limit with its reset time, a server error, an expired login — as a warning line, not as the agent's words.
  - **`api-request`** — Renders the model API call settings Claude Code logs (model, effort, thinking, max tokens, permission mode, betas, tool set) as a change log: the first call's settings, then one row per call that…
  - **`assistant-text`** — Renders assistant text events in the JSONL viewer, with optional markdown rendering; a text block the agent is still writing (a jsonl-viewer streaming stand-in) is revealed at a steady pace with a…
  - **`assistant-thinking`** — Renders assistant thinking blocks in the JSONL viewer as collapsible sections.
  - **`attachment`** — Renders attachment JSONL events with subtype dispatch to per-attachment renderer plugins.
  - **`background-shells`** — The background-shell surfaces: every background Bash shell of a conversation and its state (useConversationShells, folded from the transcript the view already holds), its live output tail…
  - **`code-listing`** — Renders `cat -n` tool output (`CatNListing`) as a syntax-highlighted, line-numbered listing: parses the gutter off and hands the code to syntax-highlight's `CodeListing`.
  - **`collapsible-card`** — Disclosure-card primitive: the whole header row is the toggle (no chevron; aria-expanded + an Expand/Collapse label carry the state), optional interactive sibling aside (never nested), and a…
  - **`compaction`** — Renders a context compaction as one thin rule across the transcript — Context compacted · 316k → 12k — folding the summary the agent continues from (as markdown), the files it re-read, and the…
  - **`event-counter`** — Displays the total event count in the conversation toolbar.
  - **`fields-card`** — Shared appearance for a headline + truncating summary preview + fold-out key/value field list. Used by the queued task-notification card and the native task-notification row so the two never diverge.
  - **`file-checkpoint`** — Renders Claude Code's rewind checkpoints (file-history-delta) in the JSONL viewer as one quiet line: the file a rewind would restore, or remove when the agent created it.
  - **`file-path`** — Clickable file path component with RTL ellipsis, copy button, and file-peek pane integration.
  - **`investigate-event`** — Contributes the add-a-renderer row action to every JSONL transcript row whose nearest dispatch fell back (unhandled event kind, tool name, or attachment subtype), launching an agent briefed to…
  - **`meta-prompt`** — Renders harness-injected prompt turns (loop/queue wakeups, resumes) distinctly from human user messages.
  - **`outline`** — The transcript's outline: one dash per user turn pinned to the right edge of the conversation, the current turn highlighted, expanding on hover into a clickable list of turns. An adapter over the…
  - **`preprompt`** — Renders the launch special-instructions (preprompt) block as a collapsible section in the JSONL viewer.
  - **`queue-operation`** — Renders Claude Code prompt-queue events (enqueue/dequeue/remove) in the JSONL viewer.
  - **`queued-prompt-card`** — Shared appearance for a queued prompt (a message the user parked while the agent was busy). Used by both the queued_command attachment and the prompt-queue enqueue row so the two never diverge.
  - **`request-shape`** — Renders the system prompt and tool set Claude Code logs for model calls (api-request-shape): the agent's tools and prompt on first use, then one row per change — a deferred tool loaded, a tool…
  - **`row-actions`** — Owns WHICH actions a JSONL transcript row carries: the JsonlRowActions.Item slot, the per-event context, and the shared action-button styling. The cluster itself (reveal, guards, popup-hold) is…
  - **`steady-reveal`** — Steady reveal for text an agent is still writing: useSteadyReveal drains a growing text at an even pace over the bursts it arrives in, its newest words fading in through a soft tail painted with the…
  - **`subagents`** — The sub-agent surfaces: how one sub-agent is going (state, elapsed, the one thing it most recently did) for the card that launched it, and the pane body that shows its write-up and its own live…
  - **`summary`** — Renders summary separator events in the JSONL viewer.
  - **`system`** — Renders system events in the JSONL viewer; an informational notice folds with the harness context around it.
  - **`task-notification`** — Renders background task completion notifications in the JSONL viewer, with a button onto the finished task that the owning plugin contributes through TaskNotification.Open (first claim wins).
  - **`teammate-message`** — Renders messages relayed from other Claude sessions (<teammate-message> blocks) distinctly from human user messages.
  - **`tool-call`** — Renders paired tool-call events with exact/pattern/fallback dispatch to per-tool renderer plugins.
  - **`transcript-stats`** — The transcript's status strip: the readings pinned at the foot of the conversation, and the TranscriptStats.Item slot they come from. Owns the reading position — the strip reports the transcript as…
  - **`user-image`** — Renders inline image thumbnails for user-image events.
  - **`user-text`** — Renders user text events in the JSONL viewer.

<!-- AUTOGENERATED:END -->
