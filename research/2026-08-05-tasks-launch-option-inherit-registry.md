# Launch-option inheritance as a registry verb

Adds `inherit` to the server half of the task launch-option registry, and
collapses the two hand-written inheritance sites onto it.

## Context

`research/2026-08-03-tasks-unified-launch-options.md` made the **write** side of
task launch options generic: an option is one plugin folder contributing a
control plus a server `apply()`, and it appears on both authoring surfaces with
no host edit. That doc explicitly scoped out the **read** side and filed it as a
follow-up.

Reviewing the read side shows it is not one consumer set but four distinct verbs
on an option's value:

| Verb | Sites | Shape |
| --- | --- | --- |
| Shape the launch | `conversations/server/internal/lifecycle.ts:37,184,203,295` | effort → argv; preprompt → first-turn text |
| Gate the launch | `conversations/server/internal/auto-start-jobs.ts:52-66` | CAS on a marker; not a launch parameter |
| **Inherit parent → child** | `tasks/server/internal/mcp-tools.ts:133-135`, `plugin-meta/plugins/plugin-health/server/internal/mcp-tools.ts:81` | `(from, to) => void` |
| Snapshot onto conversation | `conversations/plugins/conversation-preprompt/server/internal/record-job.ts:46` | preprompt only, deliberate |

**Only the inherit verb is worth generalizing now, because it has already
drifted.** `add_task` inherits preprompt *and* effort; `propose_task` inherits
preprompt *only*. So a task filed via `propose_task` silently loses the parent's
thinking mode. That is the identical failure the write-side doc was written to
fix ("thinking mode exists in the Prompt card and is absent from the draft
popover") — a contributor added later, a consumer never updated, no type error.

Intended outcome: inheritance becomes a property an option declares once, the
two consumers name no option, and the `propose_task` drift is fixed as a
side-effect rather than as a patch.

### Deliberate non-changes

The other two open verbs stay hardcoded, recorded here so they are not
re-litigated from scratch:

- **Launch-shaping** (`lifecycle.ts`) keeps its named imports. Lifecycle must
  know *what a launch is made of* — model, argv, first-turn text — and that is a
  genuinely closed list. With only two contributors, a reducer would have to
  carry the ad-hoc-opts precedence rule and the fresh-vs-resume distinction for
  no present benefit. If a third launch-shaping option ever lands, the design to
  reach for is a `FreshLaunchSpec` (has `firstTurnText`) / `ResumeLaunchSpec`
  (does not) type split — because `respawnResume` (`lifecycle.ts:292-296`)
  passes no prompt at all, "touches the first turn ⇒ fresh-only" becomes a tsc
  error rather than the comment currently doing that job at `lifecycle.ts:187-193`.
- **Auto-start's CAS gate** stays exactly where it is. It decides *whether*
  `createConversation` runs; the atomicity is the point.

## The contract

One optional member on the existing server entry. The registry is renamed to a
verb-neutral name, since it is now the server half of an option generally rather
than just "apply".

`plugins/tasks/plugins/launch-options/server/internal/contribution.ts`:

```ts
export interface TaskLaunchServerEntry<V> {
  def: LaunchOptionDef<V>;
  /** Writes one already-parsed drafted value onto a freshly created task. */
  apply: (ctx: TaskLaunchContext, value: V) => Promise<void>;
  /**
   * Copies this option from a spawning task onto a task it spawned.
   * OMITTING THIS IS THE DECLARATION that the option is not inherited — see
   * auto-start, where inheriting would auto-launch every spawned subtask.
   */
  inherit?: (fromTaskId: string, toTaskId: string) => Promise<void>;
}
```

`TaskLaunchApply` → `TaskLaunchServer`, `TaskLaunchApplyEntry` →
`TaskLaunchServerEntry`, contribution debug name `"taskLaunchApply"` →
`"taskLaunchServer"`. `TaskLaunchContext` is unchanged.

`inherit`'s signature is positional `(from, to)` deliberately: it matches
`inheritTaskEffort` / `inheritTaskPreprompt` byte-for-byte, so each contributor
registers a direct function reference with zero adapter code. It takes no
`TaskLaunchContext` — `cause` exists to thread provenance into what an `apply`
*enqueues*, and no inheritable option enqueues anything (the one that does,
auto-start, is precisely the one that must not be inherited).

### The generic read, in the collection plugin

New `plugins/tasks/plugins/launch-options/server/internal/inherit.ts`:

```ts
export async function inheritLaunchOptions(
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  for (const entry of TaskLaunchServer.getContributions()) {
    await entry.inherit?.(fromTaskId, toTaskId);
  }
}
```

Sequential, and errors propagate — a failed inherit is a real failure, not a
setting to drop. Consumers call only this; per the collection-consumer rule the
collection plugin owns the generic API, so neither MCP tool names an option
again.

No `dependsOn` wiring is needed. `collectContributions(ordered)` runs once
globally in `server-core/bin/index.ts` after the register phase and before any
handler can run, so every contributor is registered by the time an MCP handler
calls `getContributions()` — the same guarantee `handle-create-chain.ts` already
relies on.

### Rejected alternative: `read` + `apply`

Instead of a bespoke `inherit`, an option could contribute `read(taskId): V | undefined`
and the helper could compose `apply(to, await read(from))`. Rejected: auto-start
has a perfectly meaningful `read` (`getTaskAutoStart`), so adding one would
silently make it inherited — and its `apply` calls `armTaskAutoStart`, which
*enqueues a launch*. Every proposed task would start an agent. Explicit
`inherit?` keeps opting out self-describing, mirroring how the web half already
treats an absent `useTaskBinding` as "draft-only".

## Files

**Registry** — `plugins/tasks/plugins/launch-options/server/`: `internal/contribution.ts`
(rename + `inherit?`), new `internal/inherit.ts`, `index.ts` (export
`TaskLaunchServer`, `TaskLaunchServerEntry`, `inheritLaunchOptions`).

**Contributors** — each gains the renamed call; the two inheritable ones add one
line:

- `plugins/tasks/plugins/task-effort/server/index.ts` → `inherit: inheritTaskEffort`
- `plugins/tasks/plugins/task-preprompt/server/index.ts` → `inherit: inheritTaskPreprompt`
- `plugins/tasks/plugins/auto-start/plugins/launch-option/server/index.ts` →
  rename only, **no `inherit`**, with a comment stating that inheriting would
  auto-launch every spawned subtask.

Both `inheritTaskEffort` and `inheritTaskPreprompt` are **dropped from their
plugins' server barrels** (they stay in `internal/mutations.ts`, consumed only by
their own registration). This is the structural half of the fix: once the
by-name import is gone, a future consumer cannot re-hardcode it. `getTaskEffort`
/ `getTaskPreprompt` stay exported — `lifecycle.ts` still reads them, per the
non-changes above.

**Consumers** —

- `plugins/tasks/server/internal/mcp-tools.ts`: two imports and lines 133-135
  become one `await inheritLaunchOptions(currentTaskId, task.id)`.
  `currentTaskId` is non-null here (`conv` is existence-checked at :111).
- `plugins/plugin-meta/plugins/plugin-health/server/internal/mcp-tools.ts`: same
  swap at :81. Its existing `if (currentTaskId)` guard stays — `currentTaskId`
  is `conv?.taskId ?? null` there, and "no spawning task" is a legitimate state,
  not a failure the primitive should invent semantics for. **This is where the
  bug is fixed**: effort now comes along.
- `plugins/tasks/server/internal/handle-create-chain.ts`: rename of the imported
  token and type only; the apply loop is untouched.

**Docs** — `plugins/tasks/plugins/launch-options/CLAUDE.md`: document `inherit?`
alongside `apply` in the "Adding an option" section, including that omission is
the opt-out. Autogen reference blocks regenerate via `./equin build`.

### Boundary safety

`tasks/plugins/launch-options` is a `dependsOn: []` leaf (its whole closure is
`server-core/core` + `zod`), so both new edges are safe:
`tasks → tasks/plugins/launch-options` already exists via `handle-create-chain.ts`,
and `plugin-health` merely swaps its `tasks/plugins/task-preprompt` edge for the
leaf. `auto-start/launch-option → tasks` is a different node and forms no cycle.

## Verification

No automated coverage exists for this surface (unchanged from the write-side
doc); TypeScript plus manual checks are the net.

1. `./equin build` — runs `type-check` (catches every renamed call site)
   and `plugin-boundaries`, and regenerates the docs the `plugins-doc-in-sync`
   check compares against.
2. From a conversation whose task has **both** a preprompt and a thinking mode
   set, call `add_task`. Then confirm the child got both:
   ```sql
   select * from tasks_ext_preprompt where parent_id = '<child>';
   select * from tasks_ext_effort    where parent_id = '<child>';
   ```
3. **The regression under fix** — from the same conversation call `propose_task`,
   and confirm `tasks_ext_effort` now has a row for the proposed task. On `main`
   today it does not. Preprompt must still be inherited.
4. **The opt-out holds** — confirm `tasks_ext_auto_start` has **no** row for
   either child beyond what each tool arms explicitly (`add_task` arms from its
   own `autostart` param; `propose_task` arms nothing), and that the proposed
   task does not launch an agent.
5. Sanity-check the untouched write path: draft a chain in the Improve popover
   with per-card options and confirm the values still land, i.e. the rename did
   not disturb `handle-create-chain`.

## Out of scope

The launch-shaping and conversation-snapshot verbs (see *Deliberate
non-changes*), and the launch-options pairing check floated as optional
hardening in the write-side doc — `inherit` is legitimately optional, so there
is nothing for such a check to pair on here.
