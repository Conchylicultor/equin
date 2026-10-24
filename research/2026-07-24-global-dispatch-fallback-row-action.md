# Generic "unhandled row" affordance via a dispatch-outcome signal

## Context

A `SendMessage` tool call renders in the conversation transcript as a bare JSON dump with no
affordance to do anything about it. The ✨ "investigate this with an agent" button exists
(`InvestigateEventButton`) but is **hardcoded as a `trailing=` prop in exactly two components**, so
it appears on two of the four surfaces that mean "nothing handles this":

| # | component | reached when | button today |
|---|---|---|---|
| 1 | `plugins/unknown/web/components/unknown-row.tsx` | parser emitted `kind:"unknown"`; the `unknown` plugin **matches** `EventRenderer({match:"unknown"})` | ✅ |
| 2 | `plugins/attachment/web/components/generic-attachment-view.tsx` | attachment-renderer dispatch **fell back** | ✅ |
| 3 | `plugins/tool-call/web/components/generic-tool-view.tsx` | tool-renderer dispatch **fell back** — no per-tool renderer (`SendMessage`, `Grep`, `WebFetch`, un-rendered `mcp__*`) | ❌ ← the reported bug |
| 4 | `web/components/unknown-event-row.tsx` | event-renderer dispatch **fell back** — renders a dead one-liner with **no row-action strip at all** | ❌ |

The fact the affordance wants — *"this row rendered through a dispatch fallback"* — is already known
inside `defineDispatchSlot`'s `.Dispatch` (`matchedIndex < 0`) but published nowhere, so each
fallback has to be wired by hand and every new one starts out missing it.

**Outcome:** `.Dispatch` publishes its outcome; the button becomes **one** `RowAction` contribution
gated on that signal, with zero per-fallback wiring. All four surfaces get it, and so does any
future fallback.

Two structural cleanups fall out and are in scope:

- **A plugin cycle blocks the obvious fix.** `collapsible-card/web` imports `RowActions` from
  `jsonl-viewer/web`, so jsonl-viewer's *own* fallback (#4) cannot use `CollapsibleCard` — which is
  exactly why it is a dead one-liner. Extracting the row-action strip into its own sub-plugin breaks
  the cycle and unblocks card chrome for every present and future fallback.
- **`unknown` (#1) and `UnknownEventRow` (#4) are the same fact at two layers** — the parser's
  fallback and the dispatch's fallback. Once the cycle is gone they collapse into one surface, and
  #1 stops needing a special case to keep its button.

## Design

One signal, one consumer:

```
slot-render/.Dispatch ──publishes──► { slotId, key, matched }
                                            │
                                     useDispatchOutcome()
                                            │
                                   InvestigateEventAction   (a RowAction; renders null when matched)
```

Nesting is load-bearing and correct: a tool row nests `EventRenderer.Dispatch` (matched →
`ToolCallRow`) inside which `JsonlViewerTool.Renderer.Dispatch` falls back → `GenericToolView`. The
nearest-ancestor context therefore reports the *innermost* dispatch, which is the right answer in
every case: a `Bash` card is matched (hidden), a `SendMessage` card is not (shown).

The context value is deliberately **three primitives** — no `props`, no contribution object. Adding
`props` would make the value unstable on every render of a hot path (the transcript).

---

## Phase 0 — extract the row-action strip into its own sub-plugin

Breaks `jsonl-viewer/web ⇄ collapsible-card/web`. Purely mechanical; no behavior change.

**CREATE** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/`
(`package.json`, `CLAUDE.md`, `web/`), owning the whole strip:

| new file | moved from | contents |
|---|---|---|
| `web/slots.ts` | `jsonl-viewer/web/slots.ts` | `export const JsonlRowActions = { Item: defineRenderSlot<RowActionContribution>("conversation.jsonl-viewer.row-action", { docLabel: (p) => p.id }) }` + `RowActionContribution` |
| `web/internal/event-action-context.tsx` | same path under `jsonl-viewer/web` | `EventActionProvider`, `RowActions` |
| `web/components/row-action-button.tsx` | same | `RowActionButton`, `rowActionClass` |
| `web/components/copy-button.tsx` | same | `CopyTextAction` |
| `web/index.ts` | — | barrel, `contributions: []` |

- **Keep the slot id string `"conversation.jsonl-viewer.row-action"` verbatim** so persisted
  reorder directives survive the move.
- **Fix while moving:** `RowActions` currently calls `JsonlViewer.RowAction.useContributions()`
  *after* `if (!event) return null` — a conditional hook
  (`event-action-context.tsx:52-55`). Hoist the hook above the guard; this change makes the
  contribution list dynamic, so the bug would start biting.
- The new plugin must **not** import `jsonl-viewer/web`. Its only deps are
  `transcript-watcher/core`, `slot-render/web`, `hover-reveal/web`, `copy-to-clipboard/web` and the
  `css/` primitives — all already used by the moved files.

**REMOVE from `jsonl-viewer/web/index.ts`:** `EventActionProvider`, `RowActions`, `RowActionButton`,
`CopyTextAction`, `RowActionContribution`; and `RowAction` from the `JsonlViewer` object in
`web/slots.ts`. No re-export shim — cross-plugin re-exports are banned.

**Update importers** (`JsonlViewer.RowAction({…})` → `JsonlRowActions.Item({…})`; the rest are
import-path swaps):

- `jsonl-viewer/web/index.ts` (timestamp, raw-json), `web/components/event-row.tsx`,
  `web/components/event-line.tsx`, `web/components/raw-json-button.tsx`
- `plugins/collapsible-card/web/components/collapsible-card.tsx` ← **the cycle-breaking edge**
- `plugins/user-text/web/{index.ts, components/user-text-row.tsx, components/raw-toggle-action.tsx}`
- `plugins/assistant-text/web/{index.ts, components/assistant-text-row.tsx, components/markdown-toggle-action.tsx, components/copy-text-action.tsx}`
- `plugins/user-image/web/components/user-image-row.tsx`
- `plugins/tool-call/web/{index.ts, components/copy-result-action.tsx}`
- `plugins/fork-session/web/index.ts`

Resulting graph (verified DAG — `file-path/web` does **not** import `jsonl-viewer/web`):

```
jsonl-viewer/web ──► collapsible-card/web ──► row-actions/web
       └──────────────────────────────────────────┘
```

## Phase 1 — `slot-render` publishes the dispatch outcome

**CREATE** `plugins/primitives/plugins/slot-render/web/internal/dispatch-outcome.ts`

```ts
export interface DispatchOutcome {
  /** Slot id of the nearest enclosing `.Dispatch`. */
  readonly slotId: string;
  /** The dispatch key for that render, i.e. `config.key(props)`. */
  readonly key: string;
  /** True when a contribution matched; false when the slot's `fallback` rendered (or nothing did). */
  readonly matched: boolean;
}

const DispatchOutcomeContext = createContext<DispatchOutcome | null>(null); // internal — one writer
export function useDispatchOutcome(): DispatchOutcome | null;
```

**MODIFY** `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` — in `SlotDispatch`
(~:441-480), after `matchedIndex` resolution:

```ts
const matched = matchedIndex >= 0;
const outcome = useMemo(() => ({ slotId: id, key, matched }), [key, matched]);
…
return createElement(
  DispatchOutcomeContext.Provider,
  { value: outcome },
  applyItemMiddlewares(node, id, contribution),
);
```

- Depend on the **boolean** `matched`, not `matchedIndex` — reordering contributions must not churn
  the value for consumers that only care whether *anything* matched.
- Provider goes **outside** `applyItemMiddlewares` so the outcome is readable from inside an
  error-boundary fallback too.
- The `useMemo` sits after the existing `if (!ctx) throw` (a throw, not a return) and after
  `slot.useContributions()` — hook order stays unconditional.

**MODIFY** `plugins/primitives/plugins/slot-render/web/index.ts` — export `useDispatchOutcome` and
the `DispatchOutcome` type. **Not** the Context (barrel purity; one writer).

**Inertness for the other dispatch sites.** 11 further `.Dispatch` render sites gain one
zero-DOM provider fiber (`sonata.display`, `story.renderer`, `story.content`,
`config-v2.fields.renderer`, `conversation-item.avatar`, `trace.lane`, `trace.trigger-summary`,
`reports.kind-view`, `jsonl-viewer.pending-prompt`, the two jsonl-viewer ones, plus
`page.editor.block` via `defineOrderedDispatchSlot`, which is `defineDispatchSlot` at runtime).
`data-view.cell` / `cell-editor` render via `renderIsolated` and get no provider at all. Providers
emit no DOM, so no flex/layout impact; re-render fan-out is zero because
`InvestigateEventAction` is the only consumer in the repo.

## Phase 2 — unknown rows go through the dispatch fallback

With the cycle gone, jsonl-viewer's own fallback can carry the card, so the parser-level and
dispatch-level fallbacks become one surface.

**MODIFY** `jsonl-viewer/web/components/unknown-event-row.tsx` — replace the dead one-liner with the
`CollapsibleCard` body currently in `UnknownRow`, generalized over kind:

```tsx
export function UnknownEventRow({ event }: { event: JsonlEvent }) {
  const isUnknownKind = event.kind === "unknown";
  return (
    <CollapsibleCard label={isUnknownKind ? event.type : event.kind}>
      <Text as="pre" variant="caption" tone="muted" className="whitespace-pre-wrap break-words font-mono">
        {JSON.stringify(isUnknownKind ? event.raw : event, null, 2)}
      </Text>
    </CollapsibleCard>
  );
}
```

No `trailing` — the strip supplies the button now. `CollapsibleCard` already hosts `<RowActions/>`,
so this row also gains timestamp + raw-json, which it never had.

**DELETE** `jsonl-viewer/plugins/unknown/` (whole directory). Nothing imports it; `./equin
build` regenerates `web.generated.ts`, and `plugins-registry-in-sync` guards drift.

*Module-init note:* this creates `slots.ts → unknown-event-row → collapsible-card/web →
row-actions/web`. The same shape already exists and works (`slots.ts →
pending-content-indicator.tsx → ../slots`), because these are **hoisted function declarations** and
the slot object is only dereferenced at render time. Keep them as `function` declarations — a `const`
arrow would TDZ-crash at module init.

## Phase 3 — the button becomes the generic RowAction

**DELETE** `investigate-event/web/components/investigate-event-button.tsx`
**CREATE** `investigate-event/web/components/investigate-event-action.tsx`

```tsx
export function InvestigateEventAction({ event }: { event: JsonlEvent }) {
  const outcome = useDispatchOutcome();
  const conversationId = useJsonlConversationId();   // hooks before the guard
  if (!outcome || outcome.matched) return null;      // ← the entire gating rule
  …
}
```

- Trigger switches to `rowActionClass()` + `<MdAutoAwesome className="size-3" />` +
  `onClick={(e) => e.stopPropagation()}`, matching `RawJsonAction` exactly.
- **Drop `hoverRevealTarget`** — `RowActions` owns the reveal; keeping it double-applies the
  opacity/pointer-events coupling.
- `json` = the whole `event` (a superset of today's `e.raw` / `event.attachment`); label =
  `outcome.key`, which *is* `event.kind` / `event.name` / `event.subtype` depending on which
  dispatch fell back. Prompt gains `**Dispatch slot:**` / `**Dispatch key:**` lines.
- `LaunchAgentPopover`, the toast, and `conversationRoute.link(agentManagerApp, …)` are kept verbatim.

**MODIFY** `investigate-event/web/index.ts` — drop the `InvestigateEventButton` re-export, add
`JsonlRowActions.Item({ id: "investigate-event", component: InvestigateEventAction })`. New edge
`investigate-event/web → row-actions/web` + `→ jsonl-viewer/web`; no cycle (jsonl-viewer must never
import it back — collection-consumer rule).

**MODIFY** `attachment/web/components/generic-attachment-view.tsx` — delete the `trailing=` prop, the
`InvestigateEventButton` / `useJsonlConversationId` / `hoverRevealTarget` imports, and the now-unused
`conversationId` local.

> **Deliberate cost:** for `kind:"unknown"` the label becomes `"unknown"` rather than the raw
> `type`. The raw type stays visible in the row's own card label, in the serialized event in the
> prompt, and in the raw-json popover. Do **not** special-case it back — that reintroduces exactly
> the coupling this change deletes.

## Docs to update (hand-written prose)

| File | Change |
|---|---|
| `plugins/primitives/plugins/slot-render/CLAUDE.md` | New **"Dispatch outcome"** section: what `.Dispatch` publishes, that `useDispatchOutcome()` reads the *nearest* dispatch (nesting is intentional), why `props`/the contribution are excluded, and that `renderIsolated` publishes nothing. |
| `plugins/framework/plugins/web-sdk/CLAUDE.md` | One paragraph under `<Slot.Dispatch/>` pointing at `useDispatchOutcome()` as the sanctioned way to react to "nothing handled this", instead of threading a prop through fallbacks. |
| `…/jsonl-viewer/plugins/row-actions/CLAUDE.md` | **New.** Owns the strip, the slot, and the shared button styling; sits below `collapsible-card` so card chrome can host it. |
| `…/jsonl-viewer/CLAUDE.md` | New contributor rule: *never hand-place an investigate/raw-JSON affordance in a fallback renderer* — the strip contributes it automatically for any row whose nearest dispatch fell back. Mirrors the existing "never render a timestamp inline" rule. Update the moved-symbol references. |
| `…/investigate-event/CLAUDE.md` | Rewrite: no longer presentational/directly imported; it is one generic `RowAction` gated on `useDispatchOutcome().matched === false`. |
| `…/jsonl-viewer/plugins/unknown/CLAUDE.md` | Deleted with the plugin. |

Autogenerated and **not** hand-edited: `web.generated.ts`, `web-tiers.generated.ts`,
`reorderable-slots.generated.ts`, `docs/plugins-*.md`, every `AUTOGENERATED` block.

## Verification

```bash
./equin build          # regenerates registry + tiers + docs; run bun install if workspace resolution complains
./equin check          # plugin-boundaries (R6 cycle), plugins-registry-in-sync,
                             # eager-tier-in-sync, plugins-doc-in-sync, type-check, eslint
```

Expect a `web-tiers.generated.ts` regen: `investigate-event` was pulled eager by `unknown`/`attachment`
and may flip to deferred. Harmless for a hover-revealed affordance.

Pick a conversation that exercises all three dispatch levels:

```bash
rg -l '"name":"(Grep|Glob|TodoWrite|WebFetch)"' \
  ~/.claude/projects/-Users-epot---A---dev-singularity/*.jsonl | head -3   # basename = conversation id
```

Open `http://att-1784882839-vpr8.localhost:9000/agents/c/<id>` and hover rows.

**MUST show ✨** — one per level:
- Any `Grep` / `Glob` / `TodoWrite` / `WebFetch` / un-rendered `mcp__*` tool card (inner dispatch fell
  back, outer matched). **This is the reported bug: absent → present.**
- Any `attachment` with a subtype outside the 14 matched ones (e.g. `selected_lines`, `diagnostics`).
- Any `kind:"unknown"` row — still a collapsible card, and now also showing timestamp + raw-json.

**MUST NOT show ✨:**
- `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Agent`, `Skill`, `Workflow`, `Task*`,
  `AskUserQuestion`, `*add_task`, `*flag_raise` cards — inner dispatch matched. This is the nesting
  assertion.
- `assistant-text`, `user-text`, `user-image`, `assistant-thinking`, `system`, `summary`,
  `preprompt`, `meta-prompt`, `teammate-message`, `task-notification`, `queue-operation` rows.
- Attachment rows with a matched subtype; nested cards inside a matched renderer (e.g. inside an
  `Agent` or `AskUserQuestion` card).

**Regressions to assert:**
- The two former call sites show **exactly one** ✨, not two — proves the `trailing=` removal landed.
- Clicking ✨ still opens `LaunchAgentPopover`, launches, and toasts with a working link.
- Every existing row action (timestamp, raw-json, copy, markdown/raw toggles, fork-session) still
  renders and still reorders — the Phase 0 move preserved the slot id.
- No `conversations.conversation-view` pane crashes at boot (module-init order, Phase 2 note).

**Optional automation** — `…/investigate-event/e2e/investigate-event.ts` (never `*.test.ts`) using
`withBrowser`/`report()` from `@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e`:
neutralize the hover-reveal opacity with `page.addStyleTag`, then assert
`count('[aria-label="Launch agent to investigate"]')` equals the number of fallback cards on the
page and that no matched-tool card contains one.

## Risks

- **Phase 0 is the bulk of the diff** (~18 files) but is a pure move + import rewrite; type-check
  catches every miss.
- **Reorder directives** are keyed on slot id, which is preserved — but the slot's *owning plugin*
  changes. Confirm after build that any persisted `conversation.jsonl-viewer.row-action` ordering
  still applies (`./equin check` + a visual pass over a row's action order).
