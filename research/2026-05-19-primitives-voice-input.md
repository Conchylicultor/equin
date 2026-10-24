# Voice Input Plugin for Prompt Editor

## Context

Users currently type all prompts manually. Adding voice dictation lets users speak prompts instead, which is faster for natural-language instructions and more accessible. The Web Speech API is built into Chrome/Edge/Safari — zero dependencies, zero cost.

## Approach

Create a sub-plugin of `prompt-editor` that contributes a mic toggle button to the `FloatingAction` slot. When active, the Web Speech API streams recognized speech and inserts final transcripts into the Lexical editor via the existing `insertText` prop.

## File Structure

```
plugins/primitives/plugins/prompt-editor/plugins/voice-input/
├── package.json
└── web/
    ├── index.ts
    └── components/
        ├── use-speech-recognition.ts
        └── voice-input-button.tsx
```

## Implementation

### 1. `package.json`

Standard sub-plugin package with `@singularity/plugin-primitives-prompt-editor-voice-input`.

### 2. `web/index.ts` — Plugin definition

Contributes to `PromptEditorSlots.FloatingAction` with id `"voice-input"` and the `VoiceInputButton` component. Pattern mirrors `prompt-templates/web/index.ts`.

### 3. `web/components/use-speech-recognition.ts` — Hook

Manages the `SpeechRecognition` lifecycle:

- **Browser check**: `'SpeechRecognition' in window || 'webkitSpeechRecognition' in window`. Returns `isSupported: false` if absent.
- **Config**: `continuous = true`, `interimResults = false` (final-only — avoids complex Lexical interim-text replacement).
- **States**: `idle` | `listening` | error string.
- **API**: `{ isListening, error, toggle, isSupported }`.
- **Callbacks**: `onresult` iterates from `event.resultIndex`, calls `onFinalResult(transcript)` for each `isFinal` result. `onerror` maps error codes to human-readable messages. `onend` returns to idle.
- **Cleanup**: `useEffect` cleanup calls `recognition.abort()`. A `mountedRef` guards state setters.
- **Instance reuse**: One `SpeechRecognition` instance per hook mount via `useRef`, re-used across start/stop cycles (avoids Chrome's mic permission re-prompt bug on rapid recreation).

Error mapping:
| Error code | Message |
|---|---|
| `not-allowed` | "Microphone access denied" |
| `audio-capture` | "No microphone found" |
| `network` | "Network error" |
| `no-speech` | (silent → idle) |

### 4. `web/components/voice-input-button.tsx` — Component

- Receives `PromptEditorActionProps`, passes `insertText` as the `onFinalResult` callback.
- Returns `null` if `!isSupported` (button hidden, toolbar unaffected).
- Uses `IconButton` from `@plugins/primitives/plugins/icon-button/web` with:
  - `icon`: `Mic` from `lucide-react`
  - `label`: "Start voice input" / "Stop voice input"
  - `tooltip`: error message when `error !== null`
  - `className`: `text-red-500` when listening, `text-destructive` on error
- `onMouseDown={e => e.preventDefault()}` to prevent stealing Lexical focus (same pattern as `TemplateChip`).
- `aria-pressed={isListening}` for accessibility.
- Pulsing animation on the icon when recording (`animate-pulse` class on the Mic icon).

### Design decisions

- **Final-only results** (no interim): Inserting and replacing interim text in Lexical requires tracking node positions across async events — fragile and tightly coupled. Final results arrive within ~0.5-1.5s, acceptable for dictation.
- **Plain icon button, not FloatingAction hover-expand**: A single toggle with no sub-menu doesn't benefit from the expand primitive.
- **Sub-plugin of prompt-editor** (not conversation-view): Voice input is a generic editor capability, not conversation-specific.

## Key files

- `plugins/primitives/plugins/prompt-editor/web/slots.ts` — `PromptEditorSlots.FloatingAction` definition
- `plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx` — ToolbarRow rendering
- `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/index.ts` — Reference contribution pattern
- `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx` — `IconButton` component to reuse

## Verification

1. `./equin build` — plugin auto-discovered, no manual registration
2. Open `http://<worktree>.localhost:9000`, navigate to a conversation prompt
3. Mic button should appear in the floating action toolbar row
4. Click mic → browser requests microphone permission → button turns red with pulse
5. Speak → final transcript inserts at cursor in the editor
6. Click mic again → stops recording, button returns to normal
7. Open in Firefox → button hidden (no SpeechRecognition support)
8. Deny mic permission → button shows error tooltip, returns to idle
