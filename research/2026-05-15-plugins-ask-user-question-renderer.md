# AskUserQuestion JSONL tool renderer

## Context

The JSONL viewer has per-tool renderer plugins for Bash, Read, Edit, Write, Agent, Skill, and add_task. `AskUserQuestion` — the tool Claude uses to present multiple-choice questions — currently falls through to the generic JSON dump. This makes it hard to see what was asked and what was chosen.

This plan adds a dedicated renderer that shows questions as a readable poll/survey card with the selected answer highlighted.

## Files to create

All under `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/ask-user-question/`:

### `package.json`

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-tool-call-ask-user-question",
  "private": true,
  "version": "0.0.1"
}
```

### `web/index.ts`

Register with exact name match `"AskUserQuestion"`. Plugin id: `conversation-jsonl-viewer-tool-call-ask-user-question`.

### `web/components/ask-user-question-tool-view.tsx`

Main component. See design below.

### `CLAUDE.md`

Auto-generated block + one-line manual description.

## Result format (verified from real JSONL files)

`event.result.content` is a plain text string, **not JSON**:

```
User has answered your questions: "question text"="selected label", "question 2"="answer". You can now continue with the user's answers in mind.
```

Optional suffixes per answer: `user notes: <text>` and `selected preview: <text>`.

**Parser**: extract `"key"="value"` pairs via regex `/"([^"]+)"="([^"]+)"/g`. Match each value against `question.options[].label`. If no label matches, display as "Other" response.

## Component design

### Imports

- `ToolRendererProps` from `@plugins/.../tool-call/core`
- `ToolCallCard` from `@plugins/.../tool-call/web`

### Types (local)

```ts
interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskUserQuestionInput {
  questions: Question[];
}
```

### Summary (collapsed)

- Blue header badge(s) per question: `rounded px-1.5 py-0.5 font-mono text-[11px] bg-blue-500/15 text-blue-700 dark:text-blue-400`
- Truncated first question text after badges

### Body (expanded, `defaultOpen`)

For each question:
- Section label (when >1 question): `text-[10px] font-medium uppercase tracking-wider text-muted-foreground` showing `header`
- Question text: `text-xs text-foreground`
- Options list (`space-y-1`):
  - Radio (single-select) or checkbox (multi-select) indicator: `size-3 rounded-full|rounded-sm border`
  - Filled when selected: `border-primary bg-primary` with inner white dot (radio) or `✓` (checkbox)
  - Selected row: `border-l-2 border-primary bg-primary/5 rounded-md pl-2 py-1`
  - Option label: `text-xs font-medium`
  - Option description: `text-xs text-muted-foreground`
  - Optional preview: `<pre>` with `bg-muted/60 font-mono text-[10px]`
- "Other" row (when answer doesn't match any label): italic text with selection highlight

### Edge cases

| Case | Handling |
|---|---|
| No `questions` in input | Guard with `Array.isArray`, fallback badge |
| No result yet (running) | No highlights, ToolCallCard shows bouncing dots |
| `result.isError` | Show error text in `text-destructive` |
| Result parse fails | Show raw `result.content` in `<pre>` block |
| Custom "Other" answer | Extra row below options with italic text + highlight |
| Multi-select | Checkbox indicators; answer text matched against each label |
| Option with `preview` | Muted monospace block below description |
| Multi-question | Stack with `space-y-3`, section labels when >1 |

## Reference files

- Pattern to follow: `plugins/.../tool-call/plugins/skill/web/` (simplest existing renderer)
- `ToolCallCard`: `plugins/.../tool-call/web/components/tool-call-card.tsx`
- `ToolRendererProps`: `plugins/.../tool-call/core/index.ts`
- `JsonlViewerTool` slot: `plugins/.../tool-call/web/slots.ts`
- Agent badges pattern: `plugins/.../tool-call/plugins/agent/web/components/agent-tool-view.tsx`
- `plugins.generated.ts` is auto-generated — no manual edit needed

## Verification

1. `./equin build`
2. Open a conversation that has an AskUserQuestion tool call in the JSONL viewer
3. Confirm: collapsed shows blue header badge + truncated question
4. Confirm: expanded shows question text, options with indicators
5. Confirm: selected answer is highlighted with left border + filled indicator
6. Confirm: "Other" custom responses display correctly
7. Run `./equin check --plugin-boundaries` — no violations
