# Surface PreToolUse hook failures in the conversation view

## Context

A `PreToolUse:Bash hook error / Module not found` message appeared in the tmux
pane for `conv-1782751228-1xyf` but seemed absent from the conversation view. The
original hypothesis was a **capture gap** — that terminal/stderr output never
reaches the on-disk transcript and would need to be piped out of tmux into a
separate channel.

**Investigation overturned that premise.** Claude Code *does* serialize hook
failures into the transcript JSONL, as a structured event:

```json
{ "type": "attachment",
  "attachment": {
    "type": "hook_non_blocking_error",
    "hookName": "PreToolUse:Bash",
    "stderr": "Failed with non-blocking status code: error: Module not found \"plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts\"",
    "exitCode": 1,
    "command": "bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts" } }
```

The parser (`parse-jsonl.ts`) already turns `type:"attachment"` into an
`attachment` event whose `subtype` is the inner `attachment.type` string, and the
attachment renderer already dispatches per subtype. The gap is **purely in
rendering**: there are handlers for `hook_success` and `hook_additional_context`,
but **none for the hook-failure subtypes**. They fall through to
`GenericAttachmentView` — a neutral, collapsed, raw-JSON card visually identical
to benign attachments (`date_change`, `skill_listing`, …), so a build-blocking
hook failure is indistinguishable from housekeeping noise.

This is frequent, not a one-off: across on-disk transcripts,
`hook_non_blocking_error` occurs **1,521 times** (`hook_blocking_error` and
`hook_cancelled` once each). No tmux capture, no new channel, no server work is
needed — only a dedicated attachment renderer with error chrome.

## Approach

Add one new attachment sub-plugin, `hook-error`, mirroring the existing
`hook-success` plugin byte-for-byte in shape, that registers the hook-failure
subtypes against a single `HookErrorView` rendered with **destructive chrome,
expanded by default** (per decision: each failure shown loud and fully visible).

### Why a renderer, not a filter or a new event kind

The collection-consumer pattern is already in place: `JsonlViewerAttachment.Renderer`
is a `defineDispatchSlot` keyed on `event.subtype` with `GenericAttachmentView` as
fallback (`.../attachment/web/slots.ts`). Adding a contributor that matches the
failure subtypes is the sanctioned extension — zero edits to the parser, the
dispatch slot, or any consumer. The failure subtypes share the exact payload
shape of `hook_success` (`hookName`, `hookEvent`, `stderr`, `stdout`, `exitCode`,
`command`, `durationMs`), so one view covers all three.

## Files

New plugin under
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/plugins/hook-error/`:

- **`package.json`** — mirror `../hook-success/package.json`; name
  `@singularity/plugin-conversations-conversation-view-jsonl-viewer-attachment-hook-error`.
- **`web/index.ts`** — default-export `PluginDefinition` registering three
  contributions to one component (mirror `../hook-success/web/index.ts`):
  ```ts
  contributions: [
    JsonlViewerAttachment.Renderer({ match: "hook_non_blocking_error", component: HookErrorView }),
    JsonlViewerAttachment.Renderer({ match: "hook_blocking_error",     component: HookErrorView }),
    JsonlViewerAttachment.Renderer({ match: "hook_cancelled",          component: HookErrorView }),
  ]
  ```
  (`match` strings must equal the on-disk `attachment.type` values exactly, since
  dispatch keys on `event.subtype`.)
- **`web/components/hook-error-view.tsx`** — copy `HookSuccessView`
  (`../hook-success/web/components/hook-success-view.tsx`) and change:
  - `error` is **always `true`**, `defaultOpen` is **always `true`** on the
    `CollapsibleCard` (both props already exist — `collapsible-card.tsx:69,71`).
  - Label derived from `event.subtype` for accuracy:
    `hook_non_blocking_error → "Hook error"`, `hook_blocking_error → "Hook blocked"`,
    `hook_cancelled → "Hook cancelled"`, suffixed with `· <hookName ?? hookEvent>`.
    Natural case only — no all-caps (jsonl-viewer rule).
  - Body keeps the `hook-success` layout: `$ <command>`, `exit <exitCode>`, and the
    full `stderr` in `text-destructive`; also render `stdout` when present.
  - Do **not** render a timestamp (jsonl-viewer rule — `EventRow` adds it).

No changes to the parser, dispatch slot, generic fallback, or any registry by
hand — `./equin build` regenerates `web.generated.ts` and the docs/CLAUDE.md
reference blocks from the filesystem.

### Reused, unchanged

- `JsonlViewerAttachment.Renderer` dispatch slot — `.../attachment/web/slots.ts`
- `CollapsibleCard` (`error`, `defaultOpen` props) —
  `.../jsonl-viewer/plugins/collapsible-card/web`
- `HookSuccessView` as the structural template —
  `.../attachment/plugins/hook-success/web/components/hook-success-view.tsx`
- Parser already emits the `attachment` event with the correct `subtype` —
  `plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts:467`

Benign unhandled subtypes (`file`, `directory`, `ultra_effort_enter`,
`workflow_keyword_request`, …) correctly stay on `GenericAttachmentView`.

## Verification

1. `./equin build` (regenerates registry + docs; fails loudly on boundary
   or doc-sync drift).
2. Confirm the new plugin is wired: it should appear under the attachment
   `JsonlViewerAttachment.Renderer` slot in the regenerated
   `.../attachment/CLAUDE.md`.
3. Open a conversation whose transcript contains a `hook_non_blocking_error` and
   confirm a **red, expanded** card titled `Hook error · PreToolUse:Bash` showing
   the `Module not found` stderr inline (previously a muted collapsed
   `attachment:hook_non_blocking_error` JSON card). Use the scripted helper:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents/c/<id> --out /tmp/hook-error
   ```
   To find a candidate conversation in this DB, query for one whose Claude
   session transcript contains the subtype, or reproduce by temporarily breaking
   the guard import so a fresh tool call emits the attachment.
4. Confirm repeated failures each render as their own red card (expected, per the
   loud-surfacing decision) and that `hook_success` / benign attachments are
   unchanged.

## Notes / non-goals

- No tmux `pipe-pane`, stderr capture, or new log channel — the data already
  lives in the transcript; this is a rendering fix only.
- Truly terminal-*only* output (TUI spinner frames, status lines) remains out of
  scope; it is not part of the transcript and was not the actual cause here.
