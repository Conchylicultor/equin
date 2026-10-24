# Unify Improve + New-Child-Task under a `task-draft-form` primitive

## Context

`plugins/improve` (toolbar Improve button) and `plugins/conversations/plugins/conversation-view/plugins/new-child-task` (the `+` action in the conversation toolbar) ship two near-identical popovers: a free-form task description, optional model auto-start, and a submit that creates a task. Improve has the more mature surface (chained cards, drag-reorder, per-card model chip, URL/screenshot toggles, paste-images via `PromptEditor`, prefilled-attachments command for `screenshot/draw-on-app`). New-child-task is a single textarea with four submit-style buttons (`Prerequisite` / `Follow-up` / `+Sonnet` / `+Opus`) and inline image paste. The two have drifted in capability for no good reason — the underlying concept ("draft N tasks, optionally relate to an existing one, optionally auto-start") is the same.

Goal: lift improve's chain-form into a reusable primitive (`plugins/primitives/plugins/task-draft-form/`), have both consumers become thin wrappers, and replace `POST /api/improve/submit` + the new-child-task multi-call dance with a single `POST /api/tasks/chain` endpoint. New-child-task gains paste-images, chains, drag-reorder, URL capture, and a new "include parent task" capture; improve loses its bespoke server route.

## Design summary

### 1. New primitive `plugins/primitives/plugins/task-draft-form/`

Layout (library primitive, `contributions: []`):

```
plugins/primitives/plugins/task-draft-form/
├── package.json                    name: @singularity/plugin-primitives-task-draft-form
├── CLAUDE.md                       (autogen on build)
├── shared/
│   └── types.ts                    Zod schemas + types for wire body / response
├── web/
│   ├── index.ts                    barrel
│   ├── components/
│   │   ├── task-draft-popover.tsx  high-level <TaskDraftPopover/> (button + popover wrapper)
│   │   ├── task-draft-form.tsx     controlled form (lifted from improve-form.tsx)
│   │   ├── task-draft-card.tsx     single-card row (lifted from improve-card.tsx)
│   │   ├── chain-connector.tsx     lifted as-is
│   │   ├── model-chip.tsx          lifted as-is
│   │   └── relate-mode-chip.tsx    NEW: head-card toggle for prerequisite/follow-up
│   └── internal/
│       └── submit.ts               builds wire body, runs screenshot capture
```

Public API exported from `web/index.ts`:

```ts
export { TaskDraftPopover } from "./components/task-draft-popover";
export type {
  TaskDraftPopoverProps,
  TaskDraftTarget,        // { kind: "metaTask"; metaTaskId: string } | { kind: "child"; parentTaskId: string }
  TaskDraftRelate,        // { taskId: string; defaultMode: "prerequisite" | "followup" }
  CaptureKind,            // "url" | "screenshot" | "parentTask"
  PrefilledAttachment,    // { id: string; filename: string }
} from "./components/task-draft-popover";
```

Props for `TaskDraftPopover`:

```ts
interface TaskDraftPopoverProps {
  trigger: ReactNode;                           // children of the PopoverTrigger button
  triggerClassName?: string;                    // e.g. buttonVariants({ variant: "outline" })
  triggerTitle?: string;                        // title/aria-label
  target: TaskDraftTarget;                      // where new tasks go
  captures?: CaptureKind[];                     // default: ["url"]; head card shows toggles for these
  relate?: TaskDraftRelate;                     // optional; only head card honors
  prefilledAttachments?: PrefilledAttachment[]; // applied to head card on submit
  open?: boolean;                               // controlled (used by improve to react to OpenWithAttachments)
  onOpenChange?: (open: boolean) => void;
}
```

Notes:
- `screenshot` capture requires `domToBlob`-style live DOM access — only sensible at the global toolbar (improve). New-child-task omits it.
- `parentTask` capture only renders when `target.kind === "child"`. Form fetches the parent via `useResource(tasksResource)` and `find()` — no `useTask` hook exists, so the primitive does this inline. Toggle defaults to off; on submit, the wire body sets `card.includeParentTask: true` and the server inlines the parent.
- `url` toggle is per-card (head card only by default; chain cards inherit `false`). URL is captured at `onOpenChange(true)` time via `window.location.href`, same as improve does today.
- `relate-mode-chip` renders on the head card if `relate` prop is supplied. It toggles between the two modes with a default from `relate.defaultMode`. Chain cards (i > 0) keep linear "card[i] blocks card[i+1]" semantics regardless of `relate`.

The `CardDraft` shape gains one field over today's improve version:

```ts
interface CardDraft {
  localId: string;
  text: string;
  model: "queue" | "sonnet" | "opus";
  includeUrl: boolean;
  includeScreenshot: boolean;     // honored only when "screenshot" is in captures
  includeParentTask: boolean;     // NEW; honored only when "parentTask" is in captures
  // head-card-only state:
  relateMode?: "prerequisite" | "followup";  // present on head card iff relate prop is set
}
```

### 2. Wrappers

**`plugins/improve/web/components/improve-button.tsx`** shrinks to ~25 lines:

```tsx
export function ImproveButton() {
  const [open, setOpen] = useState(false);
  const [prefilled, setPrefilled] = useState<PrefilledAttachment[]>([]);

  Improve.OpenWithAttachments.useHandler(({ attachmentIds, filenames }) => {
    setPrefilled(attachmentIds.map((id) => ({
      id, filename: filenames?.[id] ?? "attachment",
    })));
    setOpen(true);
  });

  return (
    <TaskDraftPopover
      open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) setPrefilled([]); }}
      trigger={<><MdAdd className="size-4" />Improve</>}
      triggerClassName={buttonVariants({ variant: "outline", size: "sm" })}
      target={{ kind: "metaTask", metaTaskId: IMPROVEMENTS_META_TASK_ID }}
      captures={["url", "screenshot"]}
      prefilledAttachments={prefilled}
    />
  );
}
```

`IMPROVEMENTS_META_TASK_ID` stays exported from `plugins/improve/server` and is also re-exported from a small `plugins/improve/shared/constants.ts` so the web side can read it without a server import (string literal — keeps the value as the single source of truth).

**`plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/components/new-child-task-action.tsx`** shrinks to ~15 lines:

```tsx
export function NewChildTaskAction() {
  const { conversation } = conversationPane.useData();
  return (
    <TaskDraftPopover
      trigger={<MdAdd className="size-4" />}
      triggerClassName={buttonVariants({ variant: "ghost", size: "icon" })}
      triggerTitle="New child task"
      target={{ kind: "child", parentTaskId: conversation.taskId }}
      captures={["url", "parentTask"]}
      relate={{ taskId: conversation.taskId, defaultMode: "followup" }}
    />
  );
}
```

### 3. Unified server endpoint `POST /api/tasks/chain`

Lives in `plugins/tasks/server/internal/handle-create-chain.ts`, registered alongside the existing routes in `plugins/tasks/server/index.ts`. Reuses `tasks-core` mutations and `armTaskAutoStart` (already imported by `tasks/server`).

Wire schema (from `task-draft-form/shared/types.ts`, imported by the handler):

```ts
const TaskChainTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("metaTask"), metaTaskId: z.string() }),
  z.object({ kind: z.literal("child"), parentTaskId: z.string() }),
]);

const TaskChainRelateSchema = z.object({
  taskId: z.string(),
  mode: z.enum(["prerequisite", "followup"]),
});

const TaskChainCardSchema = z.object({
  text: z.string().min(1),
  launch: z.enum(["sonnet", "opus"]).nullable(),  // null = queue
  url: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
  includeParentTask: z.boolean().optional(),       // honored on head card only
});

const TaskChainSubmitBodySchema = z.object({
  target: TaskChainTargetSchema,
  relate: TaskChainRelateSchema.optional(),
  cards: z.array(TaskChainCardSchema).min(1),
});

const TaskChainSubmitResponseSchema = z.object({
  taskIds: z.array(z.string()),
});
```

Handler logic (mirrors today's `handle-submit.ts` plus relate-mode + parent-task-context):

1. Parse + Zod-validate the body.
2. Resolve `parentId = target.metaTaskId | target.parentTaskId` (single field — the server doesn't care which kind).
3. If `relate`, fetch the relate task (404 → 400). If `target.kind === "child"`, fetch the parent task (we'll need its title/description if any head card has `includeParentTask`).
4. Pre-resolve every `attachmentId` via `getAttachment(id)` (fail-fast, identical to today's improve handler).
5. For `i = 0..cards.length`:
   - Build `description` via a generalized `renderTaskDescription({ text, url, attachments, parentTaskRef })` that appends, in order, blocks for URL, attachments, and parent task. The parent-task block is wrapped in clear XML-style delimiters so the model sees boundaries cleanly:
     ```
     <parent-task id="task-abc123">
     **Title:** Refactor auth middleware
     **Description:**
     Replace the legacy session-token store with the new compliance-compliant flow…
     </parent-task>
     ```
     Only the head card honors `includeParentTask`; emit only when `target.kind === "child"` and the flag is true.
   - `createTask({ parentId, title: synthesiseTitleFallback(text), description, author })`. `author = "improve-plugin"` if `target.kind === "metaTask"`, else `"user"`.
   - `scheduleTaskTitleUpdate(newTask.id, text, fallbackTitle)`.
   - `syncOwnerAttachments(_taskAttachments, newTask.id, attachmentIds)` if any.
   - **Compute blockers for this card:**
     - If `i === 0` and `relate.mode === "followup"`: `blockerIds = [relate.taskId]`.
     - If `i === 0` and `relate.mode === "prerequisite"`: `blockerIds = []` for this task; AFTER `createTask`, call `addTaskDependency(relate.taskId, newTask.id)` (the existing task gains a blocker on the new one).
     - If `i > 0`: `blockerIds = [taskIds[i - 1]]`.
   - For each `dep` in `blockerIds`: `addTaskDependency(newTask.id, dep)`.
   - If `card.launch !== null`: `armTaskAutoStart({ taskId: newTask.id, model: card.launch, dependencies: blockerIds })`. Same shape as today.
6. Return `Response.json({ taskIds })`.

This subsumes:
- Today's `POST /api/improve/submit` (no `relate`, `target.kind === "metaTask"`).
- Today's new-child-task's `POST /api/tasks` + `POST /api/tasks/:id/dependencies` dance (with `relate` and `target.kind === "child"`).

### 4. Relate × auto-start interaction

| relate.mode    | Card[0] blockers       | Card[0] auto-start uses                         | Effect on existing task |
|----------------|------------------------|-------------------------------------------------|-------------------------|
| (none)         | []                     | enqueue immediately if `launch != null`         | none                    |
| `followup`     | `[relate.taskId]`      | wait for relate.taskId to reach done/dropped    | none                    |
| `prerequisite` | []                     | enqueue immediately if `launch != null`         | relate.taskId gains a new blocker on card[0]; if relate.taskId was armed, its trigger now waits for card[0] |

The "Queue Sonnet/Opus" actions in today's new-child-task UX correspond exactly to `relate.mode = "followup"` + `card.launch = "sonnet" | "opus"`. After unification, the user picks the mode (toggle chip) and the model (model chip) independently — no need for combined buttons.

### 5. "Include parent task" capture

- Client side: a checkbox toggle on the head card (rendered when `captures` includes `"parentTask"` and `target.kind === "child"`). Default off. Toggling sets `card.includeParentTask`.
- The form fetches the parent task via `useResource(tasksResource)` + `find()` to render a small preview ("Will include: <title>") under the toggle. No new endpoint.
- Wire: `card.includeParentTask: true` flows in the submit body. The client never sends parent-task fields itself — the server fetches them, both for security and to avoid stale duplication.
- Server side: when the flag is true on the head card, `renderTaskDescription` appends:
  ```
  ---

  <parent-task id="<id>">
  **Title:** <title>
  **Description:**
  <description or "(no description)">
  </parent-task>
  ```
  Title + id + full description (per user direction; XML-style wrapper for clear model boundaries). If the parent task's description is null/empty, emit `(no description)` to keep the structure unambiguous.

### 6. Migration of existing callers

- **`Improve.OpenWithAttachments` command** (`plugins/improve/web/commands.ts`): unchanged. Stays on the improve plugin barrel because the command opens *that specific* button's popover. The improve wrapper still binds `useHandler` and toggles its controlled `open` state.
- **Caller `plugins/screenshot/plugins/draw-on-app/web/components/draw-on-app-button.tsx`**: unchanged. Continues to call `ImproveCommands.OpenWithAttachments({ attachmentIds, filenames })` after uploading the drawing blob. The improve wrapper feeds those into `<TaskDraftPopover prefilledAttachments={...}/>`, which applies them to card[0] at submit time (same semantics as today).
- **`plugins/screenshot`** standalone screenshot button does not call `OpenWithAttachments` (it owns its own pane); no change required.

### 7. Cleanup

After the primitive lands and both wrappers consume it:

Delete from `plugins/improve/`:
- `web/components/improve-form.tsx` → moved to `task-draft-form.tsx` in primitive.
- `web/components/improve-card.tsx` → moved to `task-draft-card.tsx` in primitive.
- `web/components/chain-connector.tsx` → moved to primitive.
- `web/components/model-chip.tsx` → moved to primitive.
- `shared/types.ts` (`ImproveSubmitBody`/`ImproveSubmitCard`/`ImproveSubmitResponse`) → superseded by `task-draft-form/shared/types.ts`.
- `server/internal/handle-submit.ts` → replaced by `tasks/server/internal/handle-create-chain.ts`.
- `httpRoutes` entry in `server/index.ts`.

Keep in `plugins/improve/`:
- `web/components/improve-button.tsx` (now a thin wrapper).
- `web/commands.ts` (`Improve.OpenWithAttachments` command).
- `server/index.ts` `onReady` that calls `ensureImprovementsMetaTask()` — the meta-task lifecycle stays here since improve owns the "Improvements" concept.
- `server/internal/meta-improvements.ts` and the `IMPROVEMENTS_META_TASK_ID` constant.
- `_improve_config` table + the prompt-template settings UI (out of scope for this change).

Delete from `plugins/conversations/plugins/conversation-view/plugins/new-child-task/`:
- The bulk of `web/components/new-child-task-action.tsx` (the `submit` flow, `CreateChildTaskForm`, model labels). The new file is the ~15-line wrapper above.

## Critical files

New:
- `plugins/primitives/plugins/task-draft-form/package.json`
- `plugins/primitives/plugins/task-draft-form/CLAUDE.md` (one-line description; rest autogen)
- `plugins/primitives/plugins/task-draft-form/shared/types.ts`
- `plugins/primitives/plugins/task-draft-form/web/index.ts`
- `plugins/primitives/plugins/task-draft-form/web/components/{task-draft-popover,task-draft-form,task-draft-card,chain-connector,model-chip,relate-mode-chip}.tsx`
- `plugins/primitives/plugins/task-draft-form/web/internal/submit.ts`
- `plugins/tasks/server/internal/handle-create-chain.ts`
- `plugins/improve/shared/constants.ts` (just `export const IMPROVEMENTS_META_TASK_ID = "task-meta-improvements"`)

Modified:
- `plugins/improve/web/components/improve-button.tsx` (shrink to wrapper)
- `plugins/improve/web/index.ts` (drop `ImproveSubmitBody` re-exports if any)
- `plugins/improve/server/index.ts` (drop `httpRoutes`)
- `plugins/improve/server/internal/meta-improvements.ts` (import constant from shared)
- `plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/components/new-child-task-action.tsx` (shrink to wrapper)
- `plugins/tasks/server/index.ts` (register `POST /api/tasks/chain`)

Deleted (after migration):
- `plugins/improve/web/components/{improve-form,improve-card,chain-connector,model-chip}.tsx`
- `plugins/improve/shared/types.ts`
- `plugins/improve/server/internal/handle-submit.ts`

## Reused functions / utilities

From `tasks-core/server` (already imported by improve today):
- `createTask`, `addTaskDependency`, `synthesiseTitleFallback`, `scheduleTaskTitleUpdate`, `ensureMetaTask`, `_taskAttachments`, `getTask`.

From `tasks/server`:
- `armTaskAutoStart` (covers both immediate enqueue and per-dep trigger install).

From `infra/attachments/server`:
- `getAttachment`, `syncOwnerAttachments`.

From `primitives/paste-images/web`:
- `PromptEditor` (the primitive's `task-draft-card.tsx` keeps using this — already does in `improve-card.tsx`).
- `extractAttachmentIds` (for inline paste-image attachment ids in `submit.ts`).

From `primitives/paste-images/shared`:
- `attachmentMarkdown` (used by `renderTaskDescription` to format the attachments block).

From `primitives/live-state/web`:
- `useResource` + `tasksResource` (from `@plugins/tasks/shared`) for the parent-task preview in the form.

## Boundary check

All cross-plugin imports route through `@plugins/<chain>/{web,server,shared}` barrels. New dependencies introduced:
- `tasks/server` imports `task-draft-form/shared` → tasks → primitive (allowed; primitives are leaves on the server graph too).
- `improve/web` imports `task-draft-form/web` → improve → primitive (allowed).
- `new-child-task/web` imports `task-draft-form/web` → conversation-view sub-plugin → primitive (allowed).
- `task-draft-form/web` imports `tasks/shared` (for `tasksResource` only) → primitive → tasks/shared (allowed; shared is a separate runtime graph from web/server).

No cycles. No deep imports. Barrels stay pure (named re-exports + single default export).

## Verification

End-to-end after `./equin build`:

1. **Improve toolbar button**:
   - Click toolbar `+ Improve` → popover opens, single card.
   - Type a description, toggle URL on, submit → toast `Launched with Sonnet`. New task appears under "Improvements" with `**URL:** http://…` in the description.
   - Reopen, add a chain card via `+ task`, drag-reorder, set models per card, submit → toast `Chained 2 tasks (1 armed)`. Both tasks created with the second blocked by the first.
   - Toggle `Auto-launch with` to `No` (queue) and submit → task created without auto-start.
   - With Screenshot toggled on, submit → popover closes, DOM is captured, attachment uploaded once and shared across cards that requested it.
   - From `draw-on-app`: draw a stroke, click done → improve popover opens with the drawing as a prefilled attachment thumbnail; submit → task gets the attachment linked.

2. **New-child-task in a conversation**:
   - Open any conversation, click toolbar `+`. Popover opens with `Mode: Follow-up | Prerequisite` chip on the head card (defaulting to Follow-up), URL toggle, and `Include parent task` toggle (off).
   - Submit empty mode + Sonnet auto-launch → new child task created with parent = conversation.taskId; it depends on conversation.taskId; auto-start armed for sonnet.
   - Toggle to Prerequisite, set model to queue, submit → new task created with parent = conversation.taskId; conversation.taskId gains a blocker on the new task; new task not armed.
   - Toggle `Include parent task` on, submit → server appends the `<parent-task id="…">…</parent-task>` block to the description; verify by opening the new task in the task panel.
   - Add a chain card, set models per card, submit → multi-task chain created; relate (head only) plus chain (i>0) deps applied.
   - Paste an image into the textarea → uploads as attachment; on submit, attachment is linked to that card's task.

3. **Boundary check**: `./equin check` passes (`plugin-boundaries`, `plugins-have-claudemd`, `migrations-in-sync`).

4. **Cleanup verification**: `rg "/api/improve/submit" plugins web` returns nothing; `rg "ImproveForm\|ImproveCard\|ChainConnector\|ModelChip" plugins/improve` returns nothing.

## Out of scope

- `_improve_config` and the prompt-template settings UI (separate flow).
- Any rename of `Improve.OpenWithAttachments` (kept stable for `draw-on-app`).
- Generalizing `relate.mode` to allow more than two modes (no current need; the `z.enum` is a single-line change later if needed).
- Moving the meta-task ensurer out of improve.
