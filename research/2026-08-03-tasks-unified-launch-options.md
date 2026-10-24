# Unified task launch options

One contribution, rendered by both the task-detail Prompt card and the task-draft
popover.

## Context

Three plugins today contribute a "how does this agent launch" control to the task
detail's Prompt card via `TaskPrompt.LaunchOption`
(`plugins/tasks/plugins/task-description/web/slots.ts`): **auto-start**,
**preprompt**, **thinking mode**.

The draft popover (`task-draft-form`, driving the Improve toolbar button, the
conversation `+` button, and the two task-dependencies add buttons) mirrors the
same idea — but as hardcoded fields, in four places:

| Layer | File | What is hardcoded |
| --- | --- | --- |
| web render | `task-draft-card.tsx:200-209` | `<ModelChip>` + `<PrepromptSelect>` inlined |
| web state | `task-draft-form.tsx:26-36` | `CardDraft.model`, `CardDraft.prepromptId` |
| wire | `core/task-chain-types.ts:27-39` | `TaskChainCard.launch`, `.prepromptId` |
| server apply | `handle-create-chain.ts:119,151` | `setTaskPreprompt(...)`, `armTaskAutoStart(...)` |

The drift is already visible: **thinking mode exists in the Prompt card and is
absent from the draft popover**, because adding it means editing all four. That
is the root `CLAUDE.md` "collection-consumer separation" rule being violated — a
consumer set that must be edited per contributor.

Intended outcome: adding a fourth launch option is **one plugin folder**, and it
appears in both surfaces with no edit to either host. Thinking mode landing in
the Improve popover is the first proof, written as zero feature code.

## Why the current contract can't stretch

`TaskLaunchOption` is `{ id, label, component: ComponentType<{ taskId: string }> }`
and each control **owns its own persistence** — `TaskAutoStartControl` calls
`useTaskAutoStart(taskId)` + `setAutoStart`; effort and preprompt hit their own
`PUT /api/task-{efforts,preprompts}/:taskId`.

Pre-creation there is no `taskId`. So the contract inverts: the contribution
supplies a **controlled** control plus a **binding** for the persisted case; each
host supplies the storage.

The widgets themselves already match on both sides (`ModelSelect`,
`PrepromptSelect`, `EffortSelect`) — there is no visual reconciliation to do.

## The contract

A new leaf plugin **`plugins/tasks/plugins/launch-options/`** owns the registry.
It is deliberately neither host: `task-draft-form` importing
`task-description/web` would be a host→host edge, and the collection plugin
should own the collection.

### `core/` — one definition, imported by both runtimes

```ts
// plugins/tasks/plugins/launch-options/core/index.ts
export function defineLaunchOption<V>(def: {
  id: string;
  schema: z.ZodType<V>;   // wire + draft value type; JSON-serializable by construction
  defaultValue: V;
}): LaunchOptionDef<V>;
```

Mirrors `defineFieldType` / `defineFieldIdentity`
(`plugins/fields/core/internal/define.ts`) — a frozen core token other runtimes
import by name. Each contributor exports one from its own `core/`.

### `web/` — the slot

```ts
export const TaskLaunch = {
  Option: defineRenderSlot<{
    id: string;
    label: string;
    def: LaunchOptionDef<V>;
    component: ComponentType<{ value: V; onChange: (v: V) => void; disabled?: boolean }>;
    useTaskBinding?: (taskId: string) => { value: V; onChange: (v: V) => void };
    summarize?: (value: V) => string | null;
  }>("tasks.launch-option", { controlSize: "sm", docLabel: (p) => p.label });
};
```

Two framework constraints this shape obeys:

- **The control field must stay named `component`.** `SealContributions`
  (`web-sdk/core/sealed-component.ts:31`) seals *only* that field, forcing render
  through `.Render` and its error-boundary middleware. Naming it `Control` would
  silently opt out of crash isolation. Both hosts therefore render via
  `.Render`'s children callback (which receives the real, unsealed component) —
  exactly as `LaunchOptions` does today.
- **`useTaskBinding` is a hook on a contribution** — established practice
  (`auth`'s `useEnabled`, `detail-sections`' `useAvailable`, `theme-engine`'s
  `usePresets`). Follow the `detail-sections` calling convention
  (`define-detail-sections.tsx`): branch on the hook's *presence* in a dispatcher
  (stable per contribution, hooks-safe), then delegate to a dedicated one-hook
  wrapper component that calls it unconditionally. Never call it inline in a loop.

`useTaskBinding` optional is self-describing: omit it and the option is
draft-only. No `hosts: [...]` knob.

### `server/` — the apply registry

```ts
export const TaskLaunchApply = defineServerContribution<{
  id: string;
  schema: z.ZodType<unknown>;
  apply: (ctx: { taskId: string; cause: string }, value: unknown) => Promise<void>;
}>("taskLaunchOption", { docLabel: (c) => c.id });
```

Copy `plugins/tasks/plugins/task-category/server/internal/contribution.ts`
byte-for-byte — same `defineServerContribution` + `getContributions()` shape,
same plugin family.

**`ctx` needs no `dependencies`.** `armTaskAutoStart`
(`plugins/tasks/server/internal/arm-auto-start.ts`) accepts a `dependencies`
array and **never reads it** — gating is `hasBlockingDep(taskId, db)`, which
re-queries live rows. So `handle-create-chain.ts:141-150`'s per-relate-mode
`depsForAutoStart` computation is dead code and is deleted with this change.
*Verify this before relying on it* — confirm `dependencies` is unread at every
`armTaskAutoStart` call site, then drop the parameter from its signature too.

## Host wiring

**Detail card** (`task-description/web/components/launch-options.tsx`) — same
vertical label + control rows; the row component resolves `useTaskBinding(taskId)`
and passes `{value, onChange}` down.

**Draft card** (`task-draft-card.tsx`) — the inlined `ModelChip` and
`PrepromptSelect` are deleted and replaced by one `.Render` in the existing chip
row. Value comes from `card.options[id] ?? def.defaultValue`; `onChange` writes
back through `updateCard`.

`CardDraft` loses `model` and `prepromptId`, gains `options: Record<string, unknown>`.
`makeCard()` no longer takes model/preprompt args. Chain inheritance in
`insertAt`/`appendChainCard` (`task-draft-form.tsx:143-165`) collapses from
per-field copying to `{ ...inheritFrom.options }` — which automatically covers
every future option.

`ModelChip` (`model-chip.tsx`) and the `ChainModel` type are deleted; the
auto-start option supplies the control for both hosts.

## Wire + server

`TaskChainCardSchema` (`core/task-chain-types.ts:27-39`) trades `launch` and
`prepromptId` for `options: z.record(z.string(), z.unknown()).optional()`.
`TaskChainLaunchSchema` / `ChainModel` disappear; **`null` is the single
off-sentinel** for auto-start, replacing today's split `"queue"` (draft) vs
`"none"` (detail).

`handle-create-chain.ts` replaces both hardcoded applies with one loop over
`TaskLaunchApply.getContributions()`: per card, per registered option, parse the
value with the contribution's own `schema` and call `apply`. **An option id with
no registered apply is a 400**, not a silent skip — per the fail-loudly rule.

### Unknown ids: asymmetric handling, deliberately

- **Client strips** ids not in the live registry before submit. A stale
  localStorage draft must never block the user.
- **Server rejects** them loudly. A client sending an id no plugin claims is a
  real bug.

The submitting component (`InsertBeforeForm.submit`, `task-draft-popover.tsx:265`)
reads `TaskLaunch.Option.useContributions()` and passes the option list into
`submitChain` — `useContributions` is a hook, so the read happens in the
component, and `submit.ts` stays a pure function over an explicit list.

## Draft persistence

`CardDraft[]` is stored raw in localStorage under
`singularity:draft:task-draft:cards:<scope>`. `readDraft`
(`persistent-draft/web/draft-storage.ts:37-57`) does a blind cast — **no
validation, no migration**. A stale pre-refactor card would deserialize with
`.model`/`.prepromptId` and no `.options`, and could 400 server-side.

Repo precedent is to **rename the key** and let the old one expire on its 7-day
TTL — no versioned-envelope pattern exists anywhere. So: bump the key to
`"task-draft:cards:v2"`. One-line change, no migration code.

## Files

**New** — `plugins/tasks/plugins/launch-options/{core,web,server}/index.ts`.

**Registry contract** — `plugins/tasks/core/task-chain-types.ts`,
`plugins/tasks/server/internal/handle-create-chain.ts`.

**Hosts** — `task-description/web/{slots.ts,components/launch-options.tsx}` (slot
definition moves out; `TaskPrompt` export removed),
`task-draft-form/web/components/{task-draft-card,task-draft-form,task-draft-popover}.tsx`,
`task-draft-form/web/internal/submit.ts`, `model-chip.tsx` (deleted).

**Contributors** — each of `auto-start`, `task-preprompt`, `task-effort` gains a
`core/` definition, converts its control to controlled + a `useTaskBinding`, and
adds a server `apply`. Pattern is identical across all three; `task-effort` is
the one that gains draft-form presence it never had.

The four outer `TaskDraftPopover` call sites (`improve`, `new-child-task`,
`task-dependencies` ×2) set only `target`/`relate`/`captures`/`initialText` and
**need no changes**.

## Two visible behavior changes

1. **One wording for auto-start.** Detail says "Auto-start"/"Off", draft says
   "Auto-launch with"/"No". One contribution means one label — this plan takes
   the detail's, matching the persisted vocabulary. Trivially reversible.
2. **The toast loses its queued/created split.** `describeOutcome`
   (`submit.ts:106-126`) branches on `card.model === "queue"` and interpolates
   the model name. That vocabulary is auto-start-specific leaking into generic
   chrome. Replacement: the optional `summarize(value)` joined across options —
   *"Task created · opus · deep-think"* — with the title uniformly "Task
   created". If the queued/created distinction is worth keeping, the honest fix
   is a server response field, not client inspection of one option's value.

## Explicitly out of scope

`plugins/conversations/server/internal/lifecycle.ts` **hardcodes named imports**
of `getTaskEffort`, `getTaskPreprompt`, `getTaskAutoStart`/`claimAutoStart` inside
`createConversation`/`respawnResume`. That is the same drift in the *read at
launch* direction, and a fourth option would still require editing it. It wants a
`consume(ctx)` half on the same registry — a genuinely separate change, and
folding it in would double this one. **File as a follow-up task.**

Same for the three other creation paths that set launch config by hand: the
`add_task` MCP tool (`mcp-tools.ts:134-145`, which inherits preprompt/effort from
the spawning task), `POST /api/tasks` (`handle-create.ts:73`), and the per-field
detail routes. They can migrate onto the apply registry later; none is required
for this change.

## Verification

There is **zero automated coverage** of this surface — no tests, no e2e scripts
touch `task-draft-form`, the chain endpoint, or these options. TypeScript is the
only net, so verify by hand.

1. `./equin build` — includes `check plugin-boundaries` (the new plugin's
   barrels + no cycle) and `type-check` (which is what actually catches the
   `CardDraft`/`TaskChainCard` call sites).
2. **Reorder config migration.** The slot id changes owner, so
   `config/tasks/task-description/task-prompt.launch-option.jsonc` is replaced by
   `config/tasks/launch-options/tasks.launch-option.jsonc`. Build seeds it with a
   `// @review` marker and fails `config:overrides-authored`; restore the order
   (`auto-start`, `preprompt`, `effort`), delete the marker, rebuild. Both hosts
   render one slot, so this file now orders **both** surfaces — update its
   header comment, which currently describes only "a vertical stack".
3. Detail card at `http://<worktree>.localhost:9000/agents/…/t/<taskId>` — all
   three options render, each persists across reload (side-tables unchanged).
4. Improve popover — **thinking mode now appears**, with no code written for it.
   That is the whole point of the change; if it needs any edit to a host, the
   abstraction leaked.
5. Draft a chain, set different options per card, submit. Then
   `query_db: select * from tasks_ext_effort / _preprompt / _auto_start where task_id in (…)`
   to confirm each drafted value actually landed.
6. Stale-draft check: with a pre-change draft in localStorage under the old key,
   confirm the popover opens on a fresh card rather than erroring.
7. Screenshot both surfaces —
   `bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts`.

## Optional hardening

`plugins/config_v2/check/registrations-paired.ts` is existing precedent for a
build check that cross-diffs two independently-declared registries by derived id
and fails on either-sided orphans. The same check for launch options (every web
option id has a server `apply`, and vice versa) would turn "forgot the server
half" from a runtime 400 into a build failure. Worth adding once the contract
settles; not required to land.
