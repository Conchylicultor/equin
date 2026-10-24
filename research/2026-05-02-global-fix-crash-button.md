# Fix-this-crash button (sub-plugin contributing to a boundary slot)

## Context

When a plugin component crashes, `PluginErrorBoundary` (`plugin-core/error-boundary.tsx`) replaces it with an in-place red banner: `"<slot>/<label> crashed"`, the error message, and a Retry button. The `crashes` plugin records the crash server-side and auto-creates a task under `CRASHES_META_TASK_ID` (parent meta-task) with a markdown description containing the full traceback, URL, slot, and label. No conversation is launched on that task — fixing the crash is still a manual hop (open the meta-task, find the row, click launch).

We want a "Fix this crash" button **right in the boundary fallback**, where the user actually notices the failure. The button launches an agent on the auto-created crash task with the user's optional freeform context as the first turn — so the agent gets *both* the structured crash report (task description) and any human-supplied details (e.g. "happened after I clicked X").

Per the user's design: the boundary fallback should expose a slot (parallel in spirit to `Core.Root`) so external sub-plugins contribute action buttons. The fix-with-agent feature stays self-contained in its own nested sub-plugin and never touches the framework.

## Design

### 1. New slot: `Core.CrashAction`

Defined in [`plugin-core/slots.ts`](../plugin-core/slots.ts) alongside `Core.Root`:

```ts
export const Core = {
  Root: defineSlot<{ component: ComponentType }>("core.root"),
  CrashAction: defineSlot<{
    component: ComponentType<{ report: BoundaryErrorReport; taskId: string | null }>;
  }>("core.crash-action"),
};
```

Contributors receive:
- `report: BoundaryErrorReport` — `{ error, componentStack, slot, label }` from the boundary catch (already typed in `error-boundary.tsx:13-18`).
- `taskId: string | null` — id of the auto-created crash task once the server `report()` resolves; `null` while pending or if recording failed.

Re-exported from `plugin-core/index.ts` so plugins can `import { Core } from "@core"`.

### 2. Refactor `PluginErrorBoundary` to delegate fallback to a function component

`plugin-core/error-boundary.tsx`:

- Class component still owns `componentDidCatch` (synchronous hook React requires).
- After `reporter?.()`, treat the return value as `Promise<{ taskId: string | null } | void>`. If a Promise comes back, `then()` updates `state.taskId`. (Today the reporter return is ignored; we just start using it.)
- `render()` delegates to a new `<CrashFallback report={...} taskId={...} retry={...} />` function component. That function component reads `Core.CrashAction.useContributions()` and renders each contribution next to the existing Retry button. The current banner styling (border-destructive, text-destructive, etc.) stays.
- No structural change to the registered-reporter pattern: the `crashes` plugin keeps wiring `report()` via `registerBoundaryReporter` (`crash-reporter.tsx`). The only change there is that `report()` already returns `Promise<CrashReportResult | null>` (with `taskId`), so we just stop voiding it.

### 3. Sub-plugin: `plugins/crashes/plugins/launch-fix/`

Self-contained nested sub-plugin (per project convention, e.g. `plugins/conversations/plugins/exit/`). Contributes a button to `Core.CrashAction`.

Files:
- `plugins/crashes/plugins/launch-fix/package.json` — workspace member, name `@singularity/plugin-crashes-launch-fix`.
- `plugins/crashes/plugins/launch-fix/web/index.ts` — barrel:
  ```ts
  import { Core } from "@core";
  import { LaunchFixButton } from "./components/launch-fix-button";
  export default {
    id: "crashes-launch-fix",
    name: "Crashes: Launch fix agent",
    contributions: [Core.CrashAction({ component: LaunchFixButton })],
  } satisfies PluginDefinition;
  ```
- `plugins/crashes/plugins/launch-fix/web/components/launch-fix-button.tsx` — the button + popover:
  - Trigger: small "Fix" button inside the existing red banner (matches banner typography).
  - Popover content: a textarea labelled "Extra context (optional)" + the existing `<LaunchButtons>` primitive from `@plugins/primitives/plugins/launch/web` (Sonnet/Opus pair).
  - `LaunchButtons getRequest`: returns `{ taskId, prompt }` where `taskId = props.taskId` (the auto-created crash task) and `prompt = freeformText` (empty string is fine).
  - When `taskId` is `null`, the launch buttons are disabled with tooltip "Recording crash…".
  - Server flow: `LaunchButtons` POSTs `/api/conversations` with `{ taskId, prompt, model }`. `handle-create.ts:21-28` already forwards both fields to `createConversation`. The task description (the structured crash report auto-created by `recordCrash`) is what the agent reads on session start; the `prompt` is sent as the first user turn — so the agent sees both, exactly as the user requested.

No imports from `@plugins/crashes/web` or `…/server` are needed. The sub-plugin only depends on `@core` and `@plugins/primitives/plugins/launch/web` — clean separation.

### Why this design

- **Slot lives in plugin-core, not in the crashes plugin.** The boundary fallback IS in plugin-core, so the slot belongs where the host renders. Putting it in `crashes` would force a circular shape (plugin-core would have to call back into the crashes plugin to get the slot, which is exactly what `registerBoundaryReporter` does today — and we want to move *away* from that style for UI). The user's clarification ("like the app root slot") confirms top-level slot placement.
- **Reuses existing primitives.** `LaunchButtons` already handles model selection + the launch POST. `report()` already returns `taskId`. `recordCrash` already creates the task with full context. Net new code is the slot, the function-component fallback, and the sub-plugin button.
- **Future hosts of the same slot** (e.g. a Crashes sidebar pane subscribed to `crashesResource`) can render `Core.CrashAction.useContributions()` with the same contract — no churn for the sub-plugin.

## Files to modify / create

Modify:
- `plugin-core/slots.ts` — add `CrashAction` slot to `Core`.
- `plugin-core/error-boundary.tsx` — extract fallback to a function component, host the slot, capture `taskId` from the reporter Promise. Update the `reporter` callback type to `Promise<{ taskId: string | null } | void> | void`.
- `plugin-core/index.ts` — re-export `BoundaryErrorReport` if not already exported (contributors need the type).

Create:
- `plugins/crashes/plugins/launch-fix/package.json`
- `plugins/crashes/plugins/launch-fix/web/index.ts`
- `plugins/crashes/plugins/launch-fix/web/components/launch-fix-button.tsx`

Build step (regenerates `web/src/plugins.generated.ts`):
- `./equin build`

## Critical existing files to reuse

- `plugin-core/error-boundary.tsx:13-18` — `BoundaryErrorReport` type (slot, label, error, componentStack).
- `plugin-core/error-boundary.tsx:23-29` — `registerBoundaryReporter` pattern (mirror it conceptually, but no new register hook needed — the slot replaces that need for UI).
- `plugins/crashes/web/components/crash-reporter.tsx` — registers reporter; `report()` already returns `CrashReportResult` with `taskId`.
- `plugins/crashes/server/internal/record-crash.ts` — already creates the crash task with markdown description (no changes).
- `plugins/primitives/plugins/launch/web/components/launch-buttons.tsx:12-27` — `LaunchButtons` props (`getRequest`, `openAfterLaunch`, `onLaunched`, etc.).
- `plugins/conversations/server/internal/handle-create.ts:6-28` — confirms `taskId + prompt` are both forwarded to `createConversation`.

## Verification

1. **Build:** `./equin build` from this worktree.
2. **Open the app:** `http://att-1777710984-0uwb.localhost:9000`.
3. **Trigger a synthetic crash.** Easiest path: temporarily edit any plugin contribution component to `throw new Error("boom")` on render (e.g. add a `throw` inside the `improve` toolbar button). Reload the page.
4. **Verify the banner:** The crashed plugin's region shows the red banner with `Retry` AND a new `Fix` button.
5. **Click `Fix`:** Popover opens with a textarea + Sonnet/Opus buttons. Buttons should briefly be disabled ("Recording crash…") then enable once the server records the crash and returns `taskId`.
6. **Type freeform context** ("This happens immediately on page load") and click `Sonnet`.
7. **Verify the conversation:** Navigate to the new conversation. The task description (left panel / metadata) contains the structured crash report (errorType, message, stack, slot, label, url). The first user turn in the JSONL viewer is the freeform context. Both should be visible to the agent.
8. **Empty-context case:** Trigger another crash, click Fix, leave textarea empty, click Sonnet. Conversation launches with task description as the only context — no errored empty turn.
9. **`taskId === null` case:** Sanity-check: temporarily make `report()` reject. Banner still shows, Fix button stays disabled with the tooltip — no console errors, no broken state.
10. **Revert** the synthetic `throw` before pushing.
