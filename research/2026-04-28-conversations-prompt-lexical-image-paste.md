# Lexical-based prompt input with image paste

## Context

The conversation prompt is currently a plain `<textarea>` (`plugins/conversations/plugins/conversation-view/plugins/prompt-input/web/components/prompt-input.tsx`). The user wants to switch to [Lexical](https://lexical.dev/) as a foundation for richer prompt features (mentions, slash commands, file refs, etc.). The first concrete feature riding on this migration is **paste-to-insert images**: when a user pastes an image from the clipboard, an inline thumbnail appears in the editor, and on send the image content reaches Claude with a thumbnail rendered inline in the conversation transcript.

### Constraint: how images actually reach Claude

The intuitive model — "paste image bytes, Claude reads them" — does not work through tmux. Pasting an image into Terminal.app/iTerm relies on the *host terminal emulator* decoding the paste into an OSC/Kitty/sixel escape sequence; inside our tmux pane there is no graphical emulator, and `tmux send-keys -l` (used by `runtime-tmux/server/internal/tmux-runtime.ts:215`) only delivers literal text. Binary escape sequences would be printed as garbled characters.

The screenshot plugin already solved an equivalent problem: it writes the image to disk under `os.tmpdir()/singularity-screenshots/<id>.png` and uses Claude CLI's `@<path>` syntax in the prompt (`plugins/screenshot/server/internal/handle-save-file.ts:5,25`, `plugins/screenshot/web/components/prompt-form.tsx:18`). We mirror this pattern. **No attachments-plugin involvement.**

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser: Lexical editor                                            │
│   - Custom ImageNode (DecoratorNode) renders thumbnails            │
│   - PastePlugin intercepts clipboard image, inserts ImageNode      │
│   - Draft = serialized Lexical EditorState (in-memory)             │
│                                                                    │
│   On send: walk editor state →                                     │
│     { text: "...<<<image:0>>>...", images: [{base64, mime}] }      │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ POST /api/conversations/:id/turn
                              │ multipart/form-data
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Server: handlePostTurn (extended)                                  │
│   1. Validate each image (magic bytes, size cap)                   │
│   2. Write to tmpdir/singularity-prompt-images/<convId>/<uuid>.ext │
│   3. Replace <<<image:N>>> tokens in text with @<absolute-path>    │
│   4. sendTurn(id, finalText)  ← unchanged downstream               │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ tmux send-keys -l "...@/tmp/.../u.png..."
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Claude CLI                                                         │
│   - @<path> syntax loads file → image content block in user msg    │
│   - Logged to ~/.claude/projects/.../<session>.jsonl               │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ live-tail JSONL
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ JSONL viewer (parser + new user-image renderer plugin)             │
│   parse-jsonl.ts: detect type:"image" blocks in user content,      │
│     emit user-image event                                          │
│   user-image plugin: <img> thumbnail, click-to-expand              │
└────────────────────────────────────────────────────────────────────┘
```

## Files

### New

- `plugins/conversations/plugins/conversation-view/plugins/prompt-input/web/components/editor/`
  - `lexical-config.ts` — editor config (theme, error handler, registered nodes)
  - `image-node.tsx` — custom `DecoratorNode` extending Lexical with image thumbnail rendering and serialization
  - `image-paste-plugin.tsx` — listens for `PASTE_COMMAND`, extracts image blobs from `ClipboardEvent.clipboardData.items`, inserts an `ImageNode`
  - `enter-key-plugin.tsx` — `KEY_ENTER_COMMAND` handler: plain Enter → send, Shift+Enter → newline
  - `autosize-plugin.tsx` — observe content size changes; matches the textarea's grow-to-content behavior with a `max-h-40` cap (mirrors current Tailwind classes)
  - `serialize.ts` — `editorStateToTurnPayload(state) → { text, images }` and reverse for draft restoration
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-image/`
  - `package.json`
  - `web/index.ts` — plugin definition contributing to `JsonlViewer.EventRenderer`
  - `web/components/user-image-row.tsx` — thumbnail + click-to-expand renderer

### Modified

- `plugins/conversations/plugins/conversation-view/plugins/prompt-input/package.json` — add Lexical deps:
  - `lexical`, `@lexical/react`, `@lexical/utils` (versions: latest stable; React 19 compatibility confirmed by Lexical 0.21+)
- `plugins/conversations/plugins/conversation-view/plugins/prompt-input/web/components/prompt-input.tsx` — full rewrite around `LexicalComposer` + `PlainTextPlugin` + `ContentEditable`. Keeps `usePromptDraft`, `Shell.Toast`, the existing fetch-to-`/api/conversations/:id/turn`, and the working/stop button untouched.
- `plugins/conversations/plugins/conversation-view/web/prompt-draft-context.tsx` — change draft value type from `string` to a `PromptDraft` struct (text + image blobs) so pasted images survive intra-session conv switches. In-memory only; no localStorage. Update `usePromptDraft` API: returns `{ draft: PromptDraft, setDraft, clearDraft }` where `PromptDraft = { text: string; images: { id: string; mime: string; dataUrl: string }[] }` or similar lossy-shape adequate for restoring the editor.
- `plugins/conversations/plugins/conversation-view/plugins/fork-conversation/web/components/fork-conversation-buttons.tsx` and `plugins/conversations/plugins/conversation-view/plugins/fork-session/web/components/fork-session-buttons.tsx` — these read `draft` to seed a forked conversation. They become string-based via a helper `draftToPlainText(draft)` (drops images, since fork creates a brand-new conversation with no server-side image-rewrite path). Not a regression — fork buttons today are text-only.
- `plugins/conversations/server/internal/handle-post-turn.ts` — accept `multipart/form-data` with fields:
  - `text` (string, required)
  - one or more `image-N` parts (binary), where N matches the `<<<image:N>>>` token in `text`
  - Validate: magic bytes match `image/png|jpeg|gif|webp`, per-image cap (e.g. 10 MB), total cap (e.g. 30 MB)
  - Persist via a new helper `saveTurnImage(convId, idx, bytes, mime)` writing to `os.tmpdir()/singularity-prompt-images/<convId>/<uuid>.<ext>`
  - Substitute tokens, then call existing `sendTurn(id, finalText)` from `plugins/conversations/server/internal/runtime.ts:58`. Backward-compat: still accept JSON `{text}` body so the existing call sites keep working.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/shared/protocol.ts` — extend `JsonlEvent` union with:
  ```ts
  | { kind: "user-image"; at: string; mime: string; data: string /* base64 */ }
  ```
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/parse-jsonl.ts` — when iterating user content blocks (currently lines 92-106 only handle `text` and `tool_result`), also handle `type: "image"` blocks and emit a `user-image` event. Emission order preserves block order so a single user message with mixed content surfaces multiple events in the right sequence (event-row.tsx is first-match-by-kind, so this works without changing the slot mechanism).

### Untouched (verified during exploration)

- `plugins/conversations/plugins/runtime-tmux/` — no changes. The wire from server to Claude is still `tmux send-keys -l <text>`. The `@<path>` syntax is parsed by Claude CLI itself.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/` — left as-is. Image events render through the new sibling plugin.
- `plugins/conversations/plugins/conversation-view/web/slots.ts` — slot prop shape unchanged.

## Lexical setup details

- **Mode**: `PlainTextPlugin` (no formatting toolbar). Markdown/rich text can come later without rewrite.
- **Registered nodes**: built-in `TextNode`, `ParagraphNode`, plus custom `ImageNode`.
- **`ImageNode`** extends `DecoratorNode<JSX.Element>`:
  - `__src` (object URL for in-editor preview), `__mime`, `__dataUrl` (kept for serialization to wire payload)
  - `decorate()` returns a small `<img class="max-h-24 rounded border">` with a remove (×) button
  - Implements `exportJSON`/`importJSON` so the draft can persist via `editor.getEditorState().toJSON()`
- **`ImagePastePlugin`**:
  - Registers `PASTE_COMMAND` with `COMMAND_PRIORITY_NORMAL`
  - Iterates `event.clipboardData.items`; for each `kind === "file"` and `type.startsWith("image/")`, reads as `Blob`, creates an object URL for preview, also reads as data URL for wire serialization
  - Inserts `ImageNode` at current selection via `$insertNodes([new ImageNode(...)])`
  - Returns `true` to prevent default paste of binary garbage
  - For non-image paste, returns `false` so Lexical's default text paste handles it
- **`EnterKeyPlugin`**: registers `KEY_ENTER_COMMAND` at `COMMAND_PRIORITY_HIGH`; if `event.shiftKey === false` and not composing (IME), call `send()` and return `true`. Otherwise return `false` to let Lexical insert a newline.
- **Autosize**: a small `useLayoutEffect` reading `editor.getRootElement().scrollHeight` on every `OnChangePlugin` change, applied as inline `height` style up to `max-h-40`. Keeps parity with `fieldSizing: "content"`.
- **Disabled state**: `editor.setEditable(!disabled)` driven by the same `disabled || sending` predicate as today.

## Send-time serialization

Walk the root paragraph's children in order. Build a `text` string and an `images` array:

```ts
function serialize(state: EditorState): { text: string; images: ImagePart[] } {
  const images: ImagePart[] = [];
  let text = "";
  state.read(() => {
    for (const child of $getRoot().getChildren()) {
      // For each paragraph, walk leaf nodes in order.
      // TextNode → append textContent
      // LineBreak → "\n"
      // ImageNode → append `<<<image:${images.length}>>>`, push image to array
    }
  });
  return { text: text.trim(), images };
}
```

The token format `<<<image:N>>>` is chosen to be implausible as user-typed text. The server treats it as opaque substitution and does not validate that all tokens appear; missing tokens just leave the index unused (image still saved, but unreferenced — log a warning).

## Verification needed during implementation

These are unknown without observing real behavior; resolve with quick experiments rather than blocking the plan:

1. **What exactly does Claude CLI log to JSONL when given `@<path>` for an image in mid-conversation?** The screenshot plugin uses this on conversation *launch* (argv) but not in a turn. Three possibilities:
   - (a) Claude inlines the file as `{type: "image", source: {type: "base64", data: ...}}` in the user-message content array (preferred).
   - (b) Claude logs only the literal `@/path/...` text and the image is invisible to the JSONL viewer.
   - (c) Claude logs the path, expands the image only at API call time, and we'd need to read the file ourselves.
   
   If (a): the new `user-image` event carries the base64 directly; the renderer is `<img src={`data:${mime};base64,${data}`}>`. **Plan assumes this.**
   
   If (b) or (c): fall back to having the parser detect `@<path>` references in user-text whose path lives in `os.tmpdir()/singularity-prompt-images/`, and have the renderer fetch via a new server route `GET /api/conversations/:id/prompt-image?path=...`. Out-of-scope for v1; document as follow-up if observed.

2. **Tmux quoting of long literal text**: `tmux send-keys -l` should be safe with absolute paths like `/var/folders/.../singularity-prompt-images/<convId>/<uuid>.png`. Confirm no character (e.g. backslash, dollar sign in tmpdir) trips the literal mode. UUID-named files in our owned dir avoid this entirely.

3. **Lexical + React 19**: confirm `lexical@latest` and `@lexical/react@latest` install cleanly under the bun workspace and don't pull a conflicting React peer. If conflict, pin versions known to support React 19.

## Verification plan (end-to-end test)

1. From the worktree dir, run `./equin build`. Confirm clean build (TypeScript + Vite).
2. Open `http://<worktree>.localhost:9000`, start a conversation.
3. **Text-only sanity**: type "hello", Enter. Confirm message reaches Claude (matches today's behavior).
4. **Shift+Enter**: type "line1", Shift+Enter, "line2", Enter. Confirm two-line message arrives.
5. **Single image paste**: copy an image (Cmd+Ctrl+Shift+4 → screenshot to clipboard), focus prompt, paste. Confirm thumbnail appears inline. Type "what is this?". Send.
6. Inspect `os.tmpdir()/singularity-prompt-images/<convId>/` to confirm the file landed.
7. Confirm Claude responds about the image content (proves `@<path>` resolved on the CLI side).
8. Inspect the matching JSONL file under `~/.claude/projects/.../<session>.jsonl` to confirm what shape Claude logged the image in (resolves verification question #1 above).
9. Confirm the JSONL viewer (right pane) shows the image as a thumbnail in the user message — or, if (1.b/c), file the follow-up.
10. **Multi-image paste**: paste two images in one message with text between them. Confirm both files land on disk, both `@<path>` substitutions appear in the literal text Claude received (visible by re-running the send via `tmux capture-pane -p -t <convId>` or just observing transcript), and both render in the viewer.
11. **Draft persistence**: paste an image, type some text, switch to another conversation, switch back — content restored.
12. **Page reload**: confirm draft clears on reload (matches today's in-memory behavior).
13. **Disabled state**: navigate to a `gone` conversation; confirm editor is non-editable and shows the existing placeholder.
14. **Fork buttons**: with a text-only draft, click +Sonnet — new conversation seeds with the text. With an image in the draft, fork — text seeds, image is dropped (acceptable v1; fork plugins don't yet support image carry-over).

## Out of scope

- Persisting drafts across page reloads (intentional, matches today's behavior)
- Cleanup of stale prompt-image files in tmpdir (parallel concern; screenshot plugin has the same lifecycle)
- Fork buttons carrying images into the new conversation (would require teaching the launch path to forward images the same way; a clean future follow-up)
- Slash commands, mentions, file-ref autocomplete (Lexical primitives now in place make these straightforward to add as separate plugins)
- Markdown rendering inside the editor (`PlainTextPlugin` is sufficient; switching to `RichTextPlugin` later is a small change)
