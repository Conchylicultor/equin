# Extract `LaunchAgentPopover` from build-fix / launch-fix

## Context

Two plugins — `build/build-fix` and `crashes/launch-fix` — independently implement the same UI pattern: an `InlinePopover` containing a title, description, optional-context textarea, and `LaunchButtons`. The shared shape should be extracted into a reusable component in the `launch` primitive so future "launch agent to fix X" surfaces don't duplicate the boilerplate.

## Shared pattern (byte-for-byte identical across both)

- Controlled `InlinePopover` (`open` / `onOpenChange` via `useState`)
- Internal `text` state for the textarea
- Header: `<div class="space-y-1">` with title (`text-sm font-medium`) + subtitle (`text-xs text-muted-foreground`)
- Resizable `<textarea>` with identical styling and `min-h-[80px]`
- `<LaunchButtons size="sm" getRequest={…} onLaunched={() => setOpen(false)} />`

## Differences per consumer

| Dimension | build-fix | launch-fix |
|---|---|---|
| Trigger | Destructive-styled button, "Launch agent to investigate" | Small underline button, "Fix" |
| Title | "Investigate build failure" | "Fix this crash" |
| Description | Static string | Dynamic: `{slot / label} crashed: {message}` |
| Placeholder | "…what changed, suspected cause…" | "…what you were doing, expected behaviour…" |
| `getRequest` | Builds prompt from build logs + user text | Passes `taskId` + user text as prompt |
| `align` | `"start"` | `"end"` |
| Width | `w-[480px]` | `w-[420px]` |
| `disabled` | — | Yes, while crash task is recording |

## Design

### New component: `LaunchAgentPopover`

**Location:** `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx`

```ts
export type LaunchAgentPopoverProps = {
  trigger: React.ReactElement;
  title: string;
  description: React.ReactNode;
  placeholder?: string;
  getRequest: (userText: string) => LaunchRequest | Promise<LaunchRequest>;
  align?: "start" | "end";
  width?: string;              // e.g. "w-[480px]", default "w-[420px]"
  disabled?: boolean;
  onLaunched?: (conversation: Conversation) => void;
};
```

The component owns:
- `open` / `setOpen` state
- `text` / `setText` state for the textarea
- The `InlinePopover` shell with the trigger, header, textarea, and `LaunchButtons`
- Wires `getRequest` by passing `text` to the caller's callback: `getRequest={() => props.getRequest(text)}`
- Closes popover on launch: `onLaunched={(conv) => { setOpen(false); props.onLaunched?.(conv); }}`

### Barrel update

Export `LaunchAgentPopover` and `LaunchAgentPopoverProps` from `web/index.ts`.

### Consumer rewrites

**build-fix** (`build-fix-section.tsx`):
- Keep `BuildFixSection` (the guard) and `BuildFixButton` (fetches logs)
- Replace the inline `InlinePopover` + textarea + header with:
  ```tsx
  <LaunchAgentPopover
    trigger={<button className="…destructive…">…</button>}
    title="Investigate build failure"
    description="Launch an agent to diagnose and fix the failing build."
    placeholder="Extra context (optional) — e.g. what changed, suspected cause…"
    align="start"
    width="w-[480px]"
    getRequest={(userText) => {
      // existing log-assembly logic, using userText instead of text state
      return { prompt: parts.join("\n\n") };
    }}
  />
  ```
- Remove `useState` for `text`/`open`, `InlinePopover` import, popover markup

**launch-fix** (`launch-fix-button.tsx`):
- Replace inline popover with:
  ```tsx
  <LaunchAgentPopover
    trigger={<button …>Fix</button>}
    title="Fix this crash"
    description={<>{slotLabel} crashed: {report.error.message}</>}
    placeholder="Extra context (optional) — e.g. what you were doing, expected behaviour…"
    align="end"
    disabled={taskId === null}
    getRequest={(userText) => ({
      taskId: taskId ?? undefined,
      prompt: userText || undefined,
    })}
  />
  ```
- Remove `useState` for `text`/`open`, `InlinePopover` import, popover markup

## Files to modify

| File | Action |
|---|---|
| `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx` | **Create** — new component |
| `plugins/primitives/plugins/launch/web/index.ts` | **Edit** — add re-exports |
| `plugins/primitives/plugins/launch/CLAUDE.md` | Auto-updated by build |
| `plugins/build/plugins/build-fix/web/components/build-fix-section.tsx` | **Edit** — replace popover with `LaunchAgentPopover` |
| `plugins/crashes/plugins/launch-fix/web/components/launch-fix-button.tsx` | **Edit** — replace popover with `LaunchAgentPopover` |

## Verification

1. `./equin build` — confirms compilation, migration gen, doc gen
2. Trigger a build failure → open build detail pane → confirm "Launch agent to investigate" popover works (textarea, launch buttons)
3. Force a plugin crash (e.g. throw in a component) → confirm "Fix" button in error boundary works
4. `./equin check` — boundary checks, eslint, plugin-doc sync
