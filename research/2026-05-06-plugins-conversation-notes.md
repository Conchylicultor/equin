# Conversation Notes Plugin

## Context

The conversation view's prompt bar area lacks a way to jot down user notes — observations, reminders, or context about a conversation. Notes should be free-form text that auto-saves and always stays visible once written, so they serve as a persistent annotation layer on each conversation.

## Design

New plugin at `plugins/conversations/plugins/conversation-view/plugins/notes/` following the entity-extension + push-resource pattern established by `conversation-category` and `turn-summary`.

### Data model

Entity extension on `_conversations` with a single column:

```
conversations_ext_notes(parent_id PK FK CASCADE, notes text NOT NULL, created_at, updated_at)
```

Rows only exist when content is present — an empty save deletes the row.

### Server

Push-mode resource keyed by `conversationId` (`Record<string, NoteRow>`), matching the `turn-summaries` shape for O(1) client lookup.

Two HTTP endpoints:
- `PUT /api/conversation-notes/:conversationId` — upsert non-empty text
- `DELETE /api/conversation-notes/:conversationId` — remove the row

Both call `resource.notify()` after mutation.

### Web — hook API

Central hook composes `useResource` (server truth) with `useEditableField` (debounced auto-save, flush-on-blur, self-echo suppression):

```ts
function useConversationNote(conversationId: string): {
  // from useEditableField
  value: string;
  onChange: (next: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  flush: () => Promise<void>;
  isSaving: boolean;
  // extra
  isVisible: boolean;    // noteExists || isManuallyOpen
  noteExists: boolean;   // server has non-empty text
  toggleVisible: () => void;
}
```

The `onSave` callback routes to PUT or DELETE based on whether trimmed text is empty.

### Web — cross-tree visibility state

The notes area (`AbovePromptInput`) and toggle button (`PromptBar`) mount in different DOM positions within `ConversationView`. They share an in-memory `Map<conversationId, boolean>` via `useSyncExternalStore`, same pattern as `plugins/reorder/web/internal/edit-mode-store.ts`. Ephemeral by design — on page reload, visibility is driven purely by `noteExists`.

Auto-collapse: when server confirms deletion AND local draft is empty AND no save is in-flight, the manual-open flag clears so the area hides.

### Web — UI contributions

Two slot contributions:

1. **`Conversation.AbovePromptInput`** — `NotesArea`: a `<textarea>` that renders when `isVisible`. Minimal styling: muted background, small text, placeholder "Notes…", auto-grows. Subtle "Saving…" indicator.

2. **`Conversation.PromptBar`** — `NotesToggleButton`: a small icon button (section `"Notes"`, `sectionOrder: -1` so it's leftmost). Returns `null` when `noteExists` is true (area is always shown, button is redundant). When no notes exist, toggles the empty textarea open/close.

## File tree

```
plugins/conversations/plugins/conversation-view/plugins/notes/
├── shared/
│   ├── index.ts                          # barrel re-exports
│   └── schemas.ts                        # Zod schema + resourceDescriptor
├── server/
│   ├── index.ts                          # ServerPluginDefinition (resource + routes)
│   └── internal/
│       ├── tables.ts                     # defineExtension(_conversations, "notes", …)
│       ├── resource.ts                   # defineResource push-mode
│       └── routes.ts                     # PUT + DELETE handlers
└── web/
    ├── index.ts                          # PluginDefinition (2 slot contributions)
    ├── internal/
    │   ├── api.ts                        # fetch wrappers (upsertNote, deleteNote)
    │   ├── notes-visibility-store.ts     # useSyncExternalStore Map<id, boolean>
    │   └── use-conversation-note.ts      # central hook
    └── components/
        ├── notes-area.tsx                # AbovePromptInput contributor
        └── notes-toggle-button.tsx       # PromptBar contributor
```

## Key files to reference during implementation

| What | Path |
|------|------|
| Turn-summary resource (Record shape) | `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/internal/resource.ts` |
| Turn-summary shared schemas | `plugins/conversations/plugins/conversation-view/plugins/turn-summary/shared/schemas.ts` |
| Conversation-category routes | `plugins/conversations/plugins/conversation-category/server/internal/routes.ts` |
| Conversation-category server barrel | `plugins/conversations/plugins/conversation-category/server/index.ts` |
| Edit-mode store (useSyncExternalStore pattern) | `plugins/reorder/web/internal/edit-mode-store.ts` |
| useEditableField hook | `plugins/primitives/plugins/editable-field/web/use-editable-field.ts` |
| Conversation-view slots | `plugins/conversations/plugins/conversation-view/web/slots.ts` |
| Conversation-view layout | `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` |
| Blocked-by (PromptBar section example) | `plugins/conversations/plugins/conversation-view/plugins/blocked-by/web/index.ts` |

## Verification

1. `./equin build` — migrations generate, server starts, frontend compiles
2. Open a conversation → prompt bar shows the note icon button
3. Click the button → textarea appears above the prompt input
4. Type text → "Saving…" appears briefly, text persists after page reload
5. Clear all text → area auto-collapses after debounce, button reappears
6. Re-open the conversation → notes shown immediately without clicking
