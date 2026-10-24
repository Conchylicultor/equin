# Surface PreToolUse hook failures in the conversation view — v2

> **Supersedes v1** (`2026-06-30-conversations-hook-error-attachment-render.md`).
> v1 diagnosed only the missing *renderer* and assumed the hook-error event
> reached the UI as a muted generic card. It does not: the event is **filtered
> out before the parser ever emits it**. v2 adds the actual root-cause fix.

## Context

A `PreToolUse:Bash hook error / Module not found` appeared in the tmux pane for
`conv-1782751228-1xyf` but was **entirely absent** from the conversation view —
not even the generic fallback attachment card showed.

Two facts, both verified against real on-disk transcripts:

1. **Claude Code does serialize the failure** into the transcript JSONL, as
   `{ "type":"attachment", "attachment":{ "type":"hook_non_blocking_error",
   "hookName":"PreToolUse:Bash", "stderr":"…Module not found …guard.ts", … } }`.
   So it is *not* a tmux/stderr capture gap.

2. **The branch-filter drops it before parsing.** Claude threads a non-blocking
   hook error as a **dead-end side-leaf**: it hangs off a spine node P, but the
   conversation continues from a *sibling* of the attachment, so the attachment
   is never the highest-index leaf and never on the leaf→root path that
   `activeLineUuids` keeps. Measured on one transcript
   (`att-1782750675-pzl7/a57573ee-….jsonl`):

   | subtype | total | kept | dropped |
   |---|---:|---:|---:|
   | task_reminder, nested_memory, edited_text_file, … | (all) | 100% | 0 |
   | **hook_non_blocking_error** | **24** | **0** | **24** |

   All 24 dropped lines have their `parentUuid` **on the kept spine** — they are
   metadata leaves anchored to live nodes, dropped only for not being on the
   single active chain. Across all transcripts `hook_non_blocking_error` occurs
   **1,521 times**; siblings `hook_blocking_error` and `hook_cancelled` once each.

The fix has **two parts**: (A) stop dropping the event, (B) render it as an error
instead of a muted generic card.

## Part A — stop dropping off-spine attachment lines (root cause)

The parser gates every line through the active-uuid set:

`plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts:274`
```ts
const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
if (uuid && !keptUuids.has(uuid)) continue;
```

**Change:** admit an off-spine line when it is an `attachment` whose `parentUuid`
is on the live spine. Attachments are *annotations on their parent node*, not
branch content — they belong to the live conversation whenever their anchor does.
This is subtype-agnostic (covers all three hook-failure subtypes and any future
off-spine attachment) and cannot readmit abandoned-rewind-branch content: those
nodes are off-spine, so their `parentUuid` is not in `keptUuids`.

```ts
const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
if (uuid && !keptUuids.has(uuid)) {
  // Claude threads some attachments (e.g. a non-blocking hook error) as a
  // dead-end side-leaf off the spine: the conversation continues from a
  // sibling, so the attachment is never on the leaf→root path. An attachment
  // is an annotation of its parent, so keep it when its parent IS live. The
  // parent-on-spine guard still drops attachments on abandoned rewind branches.
  const parentUuid = typeof obj.parentUuid === "string" ? obj.parentUuid : null;
  const rescuable =
    obj.type === "attachment" && parentUuid !== null && keptUuids.has(parentUuid);
  if (!rescuable) continue;
}
```

- Keep `activeLineUuids` (`…/transcript-watcher/core/branch-filter.ts`)
  **untouched** — it is generic (uuid/parentUuid only, no `type` knowledge). The
  attachment-specific policy belongs in the parser, which already dispatches on
  `obj.type`.
- No reordering needed: lines are pushed in file order, so a rescued attachment
  renders chronologically among its neighbours.
- Optional: a `bun:test` beside the parser asserting that a hook-error attachment
  whose parent is kept survives, and one whose parent is off-spine does not.

## Part B — render the failure as an error (surfacing)

Once Part A lets the event through, it currently dispatches to
`GenericAttachmentView` (collapsed, neutral, raw JSON) — visually identical to
benign attachments. Add a dedicated renderer with destructive chrome, **expanded
by default** (per decision: each failure shown loud and fully visible).

The attachment dispatch is already a `defineDispatchSlot` keyed on `event.subtype`
with a generic fallback (`…/attachment/web/slots.ts`); adding a contributor is the
sanctioned extension — no edits to the slot, parser, or any consumer.

New sub-plugin
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/plugins/hook-error/`,
mirroring the sibling `hook-success` plugin:

- **`package.json`** — name
  `@singularity/plugin-conversations-conversation-view-jsonl-viewer-attachment-hook-error`
  (mirror `../hook-success/package.json`).
- **`web/index.ts`** — default-export `PluginDefinition` (mirror
  `../hook-success/web/index.ts`) registering three contributions to one
  component (`match` strings equal the on-disk `attachment.type` exactly):
  ```ts
  contributions: [
    JsonlViewerAttachment.Renderer({ match: "hook_non_blocking_error", component: HookErrorView }),
    JsonlViewerAttachment.Renderer({ match: "hook_blocking_error",     component: HookErrorView }),
    JsonlViewerAttachment.Renderer({ match: "hook_cancelled",          component: HookErrorView }),
  ]
  ```
- **`web/components/hook-error-view.tsx`** — copy `HookSuccessView`
  (`../hook-success/web/components/hook-success-view.tsx`; same payload shape:
  `hookName`, `hookEvent`, `stderr`, `stdout`, `exitCode`, `command`,
  `durationMs`) and change:
  - `CollapsibleCard` gets `error` **always true** and `defaultOpen` **always
    true** (both props already exist — `collapsible-card.tsx:69,71`).
  - Label from `event.subtype`: `hook_non_blocking_error → "Hook error"`,
    `hook_blocking_error → "Hook blocked"`, `hook_cancelled → "Hook cancelled"`,
    suffixed `· <hookName ?? hookEvent>`. Natural case, no all-caps (jsonl rule).
  - Body: `$ <command>`, `exit <exitCode>`, full `stderr` in `text-destructive`,
    plus `stdout` when present. No inline timestamp (`EventRow` adds it).

`./equin build` regenerates `web.generated.ts` and the docs/CLAUDE.md
reference blocks from the filesystem — never register or edit those by hand.
Benign unhandled subtypes (`file`, `directory`, `ultra_effort_enter`, …) stay on
`GenericAttachmentView`.

## Files

- `…/transcript-watcher/server/internal/parse-jsonl.ts` — Part A gate change (~6 lines).
- new `…/attachment/plugins/hook-error/{package.json,web/index.ts,web/components/hook-error-view.tsx}` — Part B.
- (optional) `…/transcript-watcher/server/internal/parse-jsonl.test.ts` — Part A unit test.

### Reused, unchanged

- `activeLineUuids` branch-filter — `…/transcript-watcher/core/branch-filter.ts` (untouched).
- `JsonlViewerAttachment.Renderer` dispatch slot — `…/attachment/web/slots.ts`.
- `CollapsibleCard` `error`/`defaultOpen` — `…/jsonl-viewer/plugins/collapsible-card/web`.
- `HookSuccessView` as the structural template — `…/attachment/plugins/hook-success/web/components/hook-success-view.tsx`.

## Verification

1. **Part A in isolation** (does the event now survive parsing): run the parser
   over a transcript known to contain `hook_non_blocking_error` (e.g. the
   `att-1782750675-pzl7` session) and confirm the emitted event list now includes
   24 `attachment`/`hook_non_blocking_error` events (0 before). A co-located
   `bun:test` is the cleanest form of this check.
2. `./equin build` (regenerates registry + docs; fails loudly on
   boundary/doc-sync drift). Confirm `hook-error` appears under the attachment
   `JsonlViewerAttachment.Renderer` slot in the regenerated `…/attachment/CLAUDE.md`.
3. **End-to-end:** open a conversation whose transcript contains a hook failure
   and confirm a **red, expanded** card `Hook error · PreToolUse:Bash` showing the
   `Module not found` stderr inline — where previously nothing appeared. Scripted:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents/c/<id> --out /tmp/hook-error
   ```
   To reproduce fresh: temporarily break the guard import so a tool call emits the
   attachment, then view the conversation.
4. Confirm benign attachments and `hook_success` are unchanged, and that no
   abandoned-rewind-branch content reappeared (Part A only adds attachments whose
   parent is already kept).

## Non-goals

- No tmux `pipe-pane` / stderr capture / new log channel — the data is already in
  the transcript; the gap was the branch-filter drop plus the missing renderer.
- Terminal-*only* output (TUI frames, status lines) stays out of scope — not part
  of the transcript and not the cause here.
