# Unify Skill and Tool Rendering in JSONL Viewer

## Context

When Claude calls the `Skill` tool, the JSONL transcript contains three separate lines:

1. **Line 1** (assistant): `tool_use` block — `name: "Skill"`, `input: { skill: "plan", args: "..." }`
2. **Line 2** (user, `isMeta=false`): `tool_result` — `content: "Launching skill: plan"`
3. **Line 3** (user, `isMeta=true`): `text` block with the full SKILL.md content, linked via `sourceToolUseID`

The parser currently emits a `tool-call` event (from lines 1+2) rendered as a generic collapsed card, and a `user-text` event (from line 3) rendered as a separate user bubble. Goal: merge them into a single collapsible card.

## Implementation

Three changes, in dependency order:

### 1. Protocol — add `injectedContext` to tool-call events

**File:** `plugins/conversations/plugins/transcript-watcher/core/protocol.ts`

Add to the `tool-call` variant:

```ts
injectedContext: z.array(z.string()).optional(),
```

Array because multiple `isMeta=true` blocks could reference the same `toolUseId`. Additive and optional — no existing consumers break.

### 2. Parser — absorb `isMeta=true` user messages

**File:** `plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts`

In the `type === "user"` branch, add an early check before the existing content-block loop:

```ts
const isMeta = obj.isMeta === true;
const sourceToolUseID = typeof obj.sourceToolUseID === "string" ? obj.sourceToolUseID : null;

if (isMeta && sourceToolUseID) {
  const linked = toolCallByUseId.get(sourceToolUseID);
  if (linked) {
    const text = extractText(msg.content);
    if (text) {
      linked.injectedContext = [...(linked.injectedContext ?? []), text];
    }
    continue;  // suppress the user-text event
  }
}
```

Uses the existing `toolCallByUseId` map and `extractText()` helper. Falls through to normal handling if no matching tool-call is found (safe default).

### 3. New sub-plugin: Skill renderer

**Location:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/skill/`

```
skill/
  CLAUDE.md
  package.json
  web/
    index.ts                  — JsonlViewerTool.Renderer({ name: "Skill", component })
    components/
      skill-tool-view.tsx     — SkillToolView
```

**Renderer design:**
- `ToolCallCard` wrapper with summary showing a `skillName` pill (e.g. "plan") + truncated args preview
- Body: full args text block + each `injectedContext` entry in a nested `<details>` (collapsed by default since SKILL.md can be very long)
- Follows the Write sub-plugin structure exactly

**Key patterns to reuse:**
- `ToolCallCard` from `@plugins/.../tool-call/web` — collapsible wrapper
- `JsonlViewerTool.Renderer` slot — exact-name registration (`name: "Skill"`)
- `toolCallByUseId` map in parser — links `sourceToolUseID` to tool-call events
- `extractText()` — handles both string and array content

## Verification

1. `./equin build`
2. Open a conversation that contains a Skill tool call (e.g. one that used `/plan`)
3. Verify: single collapsible card instead of card + user bubble
4. Verify: skill name, args, and injected context all visible in the card
5. Verify: non-Skill tool calls and regular user messages are unaffected
