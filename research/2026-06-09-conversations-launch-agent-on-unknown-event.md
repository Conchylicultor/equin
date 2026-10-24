# Launch-agent button on unknown / unhandled conversation events

## Context

In the conversation JSONL viewer, events the viewer doesn't know how to render
fall back to generic components that just dump the raw JSON in a collapsible:

- `unknown` JSONL event kinds → `UnknownRow` (`event.type`, `event.raw`)
- unrecognized attachment subtypes → `GenericAttachmentView` (`event.subtype`, `event.attachment`)
- a rare slot-level dispatch fallback → `UnknownEventRow` (only `event.kind`)

When this happens there's nothing the user can do except read JSON. We want a
**hover-revealed "Launch agent" icon** on these fallback rows that opens a popover
(modeled on the crash plugin's "Fix" button) seeding a **new** conversation whose
opening prompt contains the raw event JSON + the **source conversation id**. The
popover must also let the user pick a **preprompt**, so they can steer the agent
(e.g. "add a renderer for this event type").

### Why a preprompt input needs adding (architecture note)

A preprompt is a `prepromptId` string into the shared `preprompts` config library,
selected with the reusable `PrepromptSelect` component. Today it is only ever a
**task** property (`tasks_ext_preprompt`); a conversation *inherits* it from its
task at launch and `conversation-preprompt` snapshots it for the header chip.
There is currently **no way to launch a conversation with a directly-chosen
preprompt**. This plan closes that gap by making `prepromptId` a first-class
**conversation-creation input** — symmetric with how a task carries one — reusing
the same picker and id. The header chip stays accurate by carrying the launched
`prepromptId` in the existing `conversationCreated` event (the sanctioned way to
feed the intentionally-decoupled `conversation-preprompt` snapshot job).

## Approach

Three independent slices: (A) make preprompt a conversation-creation property,
(B) give the launch popover a slot for extra controls, (C) the new button +
fallback wiring + source-conversation-id context.

### A. Preprompt as a conversation-creation property

1. `plugins/conversations/core/endpoints.ts` — add `prepromptId: z.string().optional()`
   to `CreateConversationBodySchema`.
2. `plugins/primitives/plugins/launch/web/components/launch-control.tsx` — add
   `prepromptId?: string` to the `LaunchRequest` type. (`launch()` already spreads
   `...request` into the create body — no other change.)
3. `plugins/conversations/server/internal/handle-create.ts` — pass
   `prepromptId: body.prepromptId` into `createConversation({...})`.
4. `plugins/conversations/server/internal/lifecycle.ts`:
   - add `prepromptId?: string` to the `createConversation` opts.
   - prefer the explicit value over the task default:
     ```ts
     const prepromptId =
       opts.prepromptId ??
       (effectiveTaskId ? (await getTaskPreprompt(effectiveTaskId))?.prepromptId : undefined);
     const preprompt = resolvePreprompt(prepromptId);
     ```
     (Keep the existing `if (preprompt && !resumeSessionId)` guard — fresh launches
     have no `resumeSessionId`, so injection proceeds normally.)
   - include the resolved id in the creation event so the chip snapshot is accurate:
     add `prepromptId` to the `conversationCreated.emit({...})` payload.
5. `plugins/conversations/server/internal/tables-created-event.ts` — add optional
   `prepromptId?: string` to `ConversationCreatedPayload` (the interface already has
   `[key: string]: unknown`; make it explicit).
6. `plugins/conversations/plugins/conversation-preprompt/server/internal/record-job.ts`
   — extend the `event` zod schema with `prepromptId: z.string().optional()` and
   resolve `const prepromptId = event?.prepromptId ?? (await getTaskPreprompt(conversation.taskId))?.prepromptId;`
   (the job already uses `.passthrough()`).

### B. Native preprompt picker in the shared launch popover

`LaunchAgentPopover` is already conversation-coupled (it imports
`@plugins/conversations/core`, `conversation-view/web`, and `model-provider/web`),
so the preprompt picker belongs *in* the shared popover, not injected per-caller.
Every launch popover (crash "Fix", investigate-event, future ones) then offers
preprompt selection with zero per-caller wiring.

7. `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx`:
   - import `PrepromptSelect` from `@plugins/conversations/plugins/preprompts/web`.
   - own the state: `const [prepromptId, setPrepromptId] = useState<string | null>(null)`.
   - render `<PrepromptSelect value={prepromptId} onChange={setPrepromptId} ariaLabel="Preprompt" />`
     between the textarea and `<LaunchControl>`.
   - fold it into the request automatically — wrap the caller's `getRequest`:
     `getRequest={async () => { const r = await getRequest(text); return prepromptId ? { ...r, prepromptId } : r; }}`.
   - add an optional `showPreprompt?: boolean` (default `true`) escape hatch.
   - No cycle: `preprompts/web` does not import `launch`.

### C. Source-conversation-id context + the new button + fallback wiring

8. Source-conversation-id context (the leaf renderers receive only `{event}` via the
   slot dispatcher, so the id must come from context):
   - new `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/conversation-id-context.tsx`
     — `ConversationIdProvider` + `useJsonlConversationId(): string | null`.
   - `plugins/.../jsonl-viewer/web/components/jsonl-pane.tsx` — wrap the rendered
     content in `<ConversationIdProvider value={conversation.id}>`.
   - `plugins/.../jsonl-viewer/web/index.ts` — export `useJsonlConversationId`.
9. New presentational sub-plugin
   `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/investigate-event/`:
   - `package.json` (mirror sibling `unknown/package.json`, new workspace name).
   - `CLAUDE.md` (required by the `plugins-doc-in-sync` check).
   - `web/index.ts` — barrel: `export { InvestigateEventButton }` + a single default
     `definePlugin({ ... })` (no contributions; component is imported by name).
   - `web/components/investigate-event-button.tsx` —
     `InvestigateEventButton({ label, json, sourceConversationId })`:
     - renders `LaunchAgentPopover` with a hover-revealed small icon `trigger`
       (e.g. `MdRocketLaunch`/`MdSmartToy`) and a `getRequest(userText)` that builds
       markdown (`## Investigate JSONL event`, `**Event type:** <label>`,
       `**Source conversation:** <sourceConversationId>`, a fenced ```json block of
       `JSON.stringify(json, null, 2)`, and an optional `## Context` from `userText`)
       returning `{ prompt }`.
     - The preprompt picker + `prepromptId` are handled by `LaunchAgentPopover`
       itself (slice B) — this component does not wire them.
     - **Fresh, standalone conversation**: no `taskId`, no `forkFromConversationId`
       (we *reference* the source by id in text, not fork its session). It gets adopted
       into the conversations meta-task automatically.
   - Imports only `@plugins/primitives/plugins/launch/web` — a self-contained,
     context-free component (DAG-clean).
10. Fallback call sites render the button in the row header on hover (each already
    imports the jsonl-viewer barrel, so each calls `useJsonlConversationId()` and
    passes the id down):
    - `plugins/.../jsonl-viewer/plugins/unknown/web/components/unknown-row.tsx` —
      `<InvestigateEventButton label={e.type} json={e.raw} sourceConversationId={id} />`.
    - `plugins/.../jsonl-viewer/plugins/attachment/web/components/generic-attachment-view.tsx`
      — `label={`attachment:${event.subtype}`}` `json={event.attachment}`.
    - `plugins/.../jsonl-viewer/web/components/unknown-event-row.tsx` (rare slot
      fallback) — `label={event.kind}` `json={event}`. Include since trivial.
    - Visibility: wrap the icon so it shows on `group-hover/row` (the rows are inside
      `EventRow`'s `group/row` container), matching the existing hover row-actions.

## Relationship to the crash "Fix" button

`InvestigateEventButton` is a sibling of the crash `LaunchFixButton`
(`plugins/crashes/plugins/launch-fix`), not a merge of it. Both are thin domain
adapters over the **shared** `LaunchAgentPopover` + `LaunchControl` primitive in
`primitives/launch` — which is the unified layer (popover chrome, context box,
model dropdown, `POST /api/conversations`). They differ only in per-domain
specifics (trigger style, `getRequest` prompt construction, and request fields:
crash passes `taskId`, investigate passes none). They are intentionally **not**
unified into one component — that would force cross-plugin coupling and a leaky
mode switch. Slice B makes them converge *more* on the primitive: the preprompt
picker now lives inside `LaunchAgentPopover`, so the crash Fix button gains
preprompt selection for free, with zero per-caller code.

## Boundary / cycle check (validated)

- `unknown` / `attachment` already import the `jsonl-viewer` barrel, so the new edges
  `unknown,attachment → investigate-event → {launch, preprompts}` plus the existing
  `→ jsonl-viewer` all form a DAG. `jsonl-viewer` never imports `investigate-event`.
- `launch → preprompts` is a new edge but DAG-clean: `preprompts/web` imports only
  config_v2 + primitives (select/avatar), never `launch`. It's consistent with
  `launch`'s existing conversations dependencies (`core`, `conversation-view/web`,
  `model-provider/web`).
- The web plugin registry (`web.generated.ts`) is regenerated by `./equin build`
  from imports — **no manual registry edit needed**; the new sub-plugin is auto-discovered.

## Files to create / modify

Create: `investigate-event/{package.json,CLAUDE.md,web/index.ts,web/components/investigate-event-button.tsx}`,
`jsonl-viewer/web/components/conversation-id-context.tsx`.

Modify: `endpoints.ts`, `launch-control.tsx`, `launch-agent-popover.tsx`,
`handle-create.ts`, `lifecycle.ts`, `tables-created-event.ts`, `record-job.ts`,
`jsonl-pane.tsx`, `jsonl-viewer/web/index.ts`, `unknown-row.tsx`,
`generic-attachment-view.tsx`, `unknown-event-row.tsx`.

## Verification

1. `./equin build` (regenerates migrations none-needed here, the web registry,
   and docs; run `./equin check` if the doc-sync check complains).
2. Open a conversation that has an unknown event or unrecognized attachment at
   `http://<worktree>.localhost:9000`. Hover the fallback row → the launch icon
   appears. (To force one, you can inspect a conversation known to emit a not-yet-
   handled type, or temporarily craft a transcript line.)
3. Click the icon → popover opens with: description, free-text box, a `PrepromptSelect`,
   and the model launch control. Pick a preprompt + optionally type context → Launch.
4. Confirm a new conversation opens whose first turn contains the fenced event JSON,
   the source conversation id, and (collapsed `preprompt` row) the chosen preprompt as
   a `<special_instructions>` block; confirm the new conversation's **header preprompt
   chip** shows the chosen preprompt (validates the event/record-job propagation).
5. Scripted check with `bun e2e/screenshot.mjs --url <conv-url> --click "<launch aria-label>"`
   to capture before/after and the button state.
