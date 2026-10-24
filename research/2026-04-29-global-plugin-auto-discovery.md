# Plugin auto-discovery + lazy `Registration` lifecycle

## Context

Today every plugin must be hand-listed in three places: `web/src/plugins.ts`
(180 entries), `server/src/plugins.ts` (46 entries), and `central/src/plugins.ts`
(4 entries). Each new plugin requires editing one of those files; nesting
(`plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web`)
makes the list increasingly noisy. The deeper problem is that **plugin load
order is load-bearing but implicit** — the comments in `server/src/plugins.ts`
flag it ("runtime plugins must load before `conversationsPlugin`", "`mcpPlugin`
must load before any plugin that registers an MCP tool"), and that ordering
is enforced today only by careful array placement plus side-effect-on-import.

We want two things:
1. **Auto-discover** plugins via glob so the registry files become generated/cosmetic.
2. **Make registry writes declarative** by replacing side-effect imports with
   a `register: Registration[]` field whose tokens the framework applies in
   topo-sorted order. The "import a module to trigger its side effects"
   anti-pattern goes away; the load-order comments evaporate.

## Proposed lifecycle

### Server / central — three phases

```
1. register phase     — sequential, in topo-sorted plugin order
2. migrate phase      — drizzle migrations (already exists)
3. onReady() phase    — parallel (already exists)
4. onShutdown() phase — parallel (already exists)
```

The register phase walks `plugin.register: Registration[]` for each plugin
in topo order and invokes `r.register()` on each token. It is the **only**
place where plugins write to global registries (`Mcp.tool`, `Runtime.define`,
`defineJob`, `defineTriggerEvent`, durable-hook installation, etc.).

Registry *singletons* (the `Mcp` object, `Runtime` map, `jobRegistry`) keep
being declared at module-load time — they are pure value declarations with
no I/O. Only the **write calls** move into the register phase.

### The `Registration` interface

```ts
// plugin-core/types.ts (shared by web/server/central)
export interface Registration {
  register: () => void | Promise<void>;
}
```

Every registry helper returns a `Registration`. The framework loop is:

```ts
for (const p of ordered) {
  for (const r of p.register ?? []) {
    await r.register();
  }
}
```

### Lazy registry helpers

| Helper today | After |
|---|---|
| `Mcp.registerTool(spec): void` (writes immediately) | `Mcp.tool(spec): Registration` (renamed; lazy) |
| `Runtime.register(rt): void` (writes immediately) | `Runtime.define(rt): Registration` (renamed to match `defineJob` convention; lazy) |
| `UNSAFE_installDurableHooks(spec): void` | `UNSAFE_installDurableHooks(spec): Registration` (lazy) |
| `defineJob(spec): JobFactory` (writes + returns factory) | `defineJob(spec): JobFactory & Registration` (lazy registry write) |
| `defineTriggerEvent(spec): { table, event }` (writes + returns) | `defineTriggerEvent(spec): { table, event: EventHandle & Registration }` (lazy registry write) |

Renames clarify the semantic shift: `Mcp.registerTool` and `Runtime.register`
read as imperative side effects, but the new shape is declarative. The
existing `define*` verb (`defineJob`, `defineTriggerEvent`, `defineConfig`)
is the right convention.

### Dual-purpose factories

For helpers that already return a value the rest of the plugin uses
(`defineJob`, `defineTriggerEvent`), the returned object is the factory
**and** the `Registration` — the same identifier serves both roles.

```ts
// plugins/infra/plugins/events/server/internal/dispatch-job.ts
export const dispatchJob = defineJob({...});
// dispatchJob.enqueue(...) used elsewhere in the plugin (factory role)
// dispatchJob.register() called by the framework (Registration role)
```

```ts
// plugins/tasks-core/server/internal/tables-events.ts (unchanged destructuring)
export const { table: _taskStatusChanged, event: taskStatusChanged } =
  defineTriggerEvent({...});
// _taskStatusChanged is the Drizzle table (schema export, unchanged)
// taskStatusChanged is EventHandle & Registration — used as event.emit(...)
//   and listed in `register: [taskStatusChanged]`
```

The Drizzle `table` field stays on the outer object so existing schema
exports (`_taskStatusChanged`, etc.) keep working without churn. The
`Registration` mixin lives on the `event` field, which is the part the
plugin barrel actually lists in its `register` array.

### Why deferring the writes is safe

- `JobFactory.enqueue` does not read `jobRegistry`. It writes to
  `graphile_worker.jobs` with `identifier := JOB_TASK` and embeds the job
  name in the JSON payload. Handler lookup (`UNSAFE_getRegisteredJob`)
  happens at job-pickup time inside the worker, which only starts in
  `onReady` (`plugins/infra/plugins/jobs/server/index.ts:46-49`).
- All `Registration.register()` calls within a single plugin are commutative
  unless `dependsOn` is set; commutative across plugins unless one plugin's
  `register()` *reads* another's registry (the `dependsOn` case below).
- Duplicate-name guards (`if (jobRegistry.has(spec.name)) throw …`) move
  from construction time into the `register()` body. The error still fires
  before `onReady`, so boot still fails loudly.

### Web — no new phase needed

Web contributions are pure declarative data (`contributions: [...]` on the
plugin object). They are collected into the `PluginProvider` context on
mount with no side effects. We add an *optional* `register: Registration[]`
to `PluginDefinition` for symmetry, but no current web plugin needs it. The
mount-time loop invokes each `register()` synchronously (the React mount
path is sync; sync-only on web).

## Why the famous "runtimes before conversations" rule disappears

The comment in `server/src/plugins.ts:46-49` is a workaround for having only
**one phase** today: module-load. The phase split makes the rule
unnecessary — no `dependsOn`, no auto-inference, no comment to maintain:

- `runtime-tmux`'s `register` is `[Runtime.define(tmuxRuntime)]`.
- `runtime-api`'s `register` is `[Runtime.define(apiRuntime)]`.
- `conversations`'s `onReady()` calls `startPoller()`, which reads
  `Runtime.all()`.

Bootstrap runs **all** register tokens before **any** `onReady()` call, so
the registrations are guaranteed-visible when the poller starts. Phase
ordering replaces array ordering. Same story for `Mcp.tool` and
`defineJob`.

### Could we auto-infer `dependsOn` from the import graph?

Tempting, but it's the wrong direction for the registry-host pattern:
`runtime-tmux` *imports* `Runtime` from `@plugins/conversations/server` (so
the import edge is `runtime-tmux → conversations`), yet at init time
`runtime-tmux` must run *first* (init edge: `conversations → runtime-tmux`).
Naive import-based inference would order them backwards. The phase split
sidesteps the need; explicit `dependsOn` is the escape hatch for the rare
case where one plugin's register tokens *read* what another plugin's
register tokens wrote.

## `dependsOn` — explicit ordering for cross-plugin register reads

```ts
interface ServerPluginDefinition {
  // ...
  dependsOn?: ServerPluginDefinition[];
  register?: Registration[];
  onReady?: () => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
}
```

`dependsOn` is the **init DAG**, independent of the import DAG enforced by
`--plugin-boundaries`:

- **Import DAG**: registrant → host (e.g. `runtime-tmux` imports `Runtime`
  from `@plugins/conversations/server`).
- **Init DAG**: host → registrants (host's `onReady` reads what registrants
  wrote in the register phase).

These are independent constraints; each must be acyclic on its own. In
practice their union has no cycles — the phase split absorbs the
registry-inversion case automatically.

`dependsOn` exists for the rare case where plugin B's register tokens read
state plugin A's register tokens produced. Concretely, the events plugin
exposes a `trigger()` API that **reads** `triggerTableRegistry` (populated
by `defineTriggerEvent.register()`). Any plugin whose `register()` writes
call `trigger(...)` for an event owned by another plugin must list that
plugin in `dependsOn` — otherwise the read silently misses. None of the
current callers do this (all `trigger()` calls happen inside `onReady`),
but the constraint is real and worth documenting in the events plugin's
CLAUDE.md.

If `dependsOn` ever forms a cycle, the topo-sort surfaces it loudly as a
boot-time error.

## Auto-discovery

Two implementation paths; pick **(A)** for clarity.

### (A) Build-time codegen — recommended

Extend `cli/src/docgen.ts`'s existing `collectAllPlugins(root)` walker
(`cli/src/docgen.ts:71+`) to emit three files during `./equin build`:

- `web/src/plugins.generated.ts`
- `server/src/plugins.generated.ts`
- `central/src/plugins.generated.ts`

Each file is a sorted list of `import` + `export const plugins = [...]`,
exactly the shape we have today, but generated. The current hand-written
files become 1-line re-exports:

```ts
// server/src/plugins.ts
export { plugins } from "./plugins.generated";
```

Generated files are committed to git (so diffs are reviewable, grep still
works, no need for a pre-build step on `bun install`). A new check
`plugins-registry-in-sync` (mirror of `migrations-in-sync`) fails CI if
the generated file is stale.

Pros: deterministic, one source of truth (filesystem), checker can lint
the generated file, no runtime cost, works identically on web/server/central.

### (B) Runtime glob — alternative

Use `import.meta.glob('@plugins/**/web/index.ts', { eager: true })` (web)
and `Bun.glob` (server). Skipped because: (i) glob ordering is bundler-defined
and load-bearing, (ii) lazy/eager toggle is one more thing to configure,
(iii) no clean way to keep the human-readable plugin list in `plugins-compact.md`
synchronized.

## Topo-sort

`server/src/index.ts` reads `plugins` from the generated array and runs:

```ts
const ordered = topoSort(plugins, p => p.dependsOn ?? []);
for (const p of ordered) {
  for (const r of p.register ?? []) await r.register();
}
await runMigrations();
await Promise.all(ordered.map(p => p.onReady?.()));
```

Topo-sort yields a deterministic order; cycles throw with a clear "init
cycle: A → B → A" error. Same shape on `central/src/index.ts`.

## Side effects to lift

The staged diff in this branch already partially migrated several plugins
to a `register: () => void` *function* shape (the v1 design). The lift
below replaces that with the lazy-Registration array pattern.

| Plugin | Current state | Target |
|---|---|---|
| `conversations` | `internal/auto-start-jobs` is a named re-export; `defineJob` calls fire at module load | `register: [taskStartJob, taskCancelJob]` (factories declared in `internal/auto-start-jobs.ts` and listed in barrel) |
| `runtime-tmux` | already migrated to `register: register` function shape | `register: [Runtime.define(tmuxRuntime)]` (delete `internal/register.ts` shim) |
| `runtime-api` | already migrated to `register: register` function shape | `register: [Runtime.define(apiRuntime)]` (delete shim) |
| `infra/jobs` | `import "./internal/resume-job"` is still a bare side-effect import | `register: [jobsResumeJob]` (factory already exists as named export) |
| `infra/events` (dispatch) | `import "./internal/dispatch-job"` is still a bare side-effect import | `register: [dispatchJob]` |
| `infra/events` (durable hooks) | already migrated to `register: registerJobsHooks` function shape | `register: [..., UNSAFE_installDurableHooks(hooks)]` (inline since it's a pure call) |
| `conversations/summary` | already migrated to `register: register` function shape | `register: [Mcp.tool(submitSummaryTool)]` (delete shim) |
| `tasks` | already migrated to `register: register` function shape | `register: [Mcp.tool(addTaskTool)]` (delete shim) |

`conversations`'s `startPoller()` / `startTurnEmitter()` are already in
`onReady` — no change. `build`'s `trigger(...)` subscription is already in
`onReady` — no change. After this lift, the comments in
`server/src/plugins.ts:46-49` about load order can be deleted.

## Worked before/after

### Example 1 — `runtime-tmux` (canonical Runtime registry case)

**Before** — barrel pulls a side-effect-only import:

```ts
// plugins/conversations/plugins/runtime-tmux/server/index.ts
import type { ServerPluginDefinition } from "@server/types";
import "./internal/register";   // <-- side effect: Runtime.register(tmuxRuntime)

export default {
  id: "conversations-runtime-tmux",
  name: "Conversations Runtime: tmux",
  description: "Runs Claude CLI sessions inside tmux panes.",
} satisfies ServerPluginDefinition;
```

```ts
// plugins/conversations/plugins/runtime-tmux/server/internal/register.ts
import { Runtime } from "@plugins/conversations/server";
import { tmuxRuntime } from "./tmux-runtime";

Runtime.register(tmuxRuntime);   // <-- top-level statement, fires on import
```

**After** — barrel calls `Runtime.define(tmuxRuntime)` inline; no `internal/register.ts` shim:

```ts
// plugins/conversations/plugins/runtime-tmux/server/index.ts
import type { ServerPluginDefinition } from "@server/types";
import { Runtime } from "@plugins/conversations/server";
import { tmuxRuntime } from "./internal/tmux-runtime";

export default {
  id: "conversations-runtime-tmux",
  name: "Conversations Runtime: tmux",
  description: "Runs Claude CLI sessions inside tmux panes.",
  register: [Runtime.define(tmuxRuntime)],
} satisfies ServerPluginDefinition;
```

`Runtime.define(tmuxRuntime)` is pure — it returns a `Registration` token
without writing to the registry, so the barrel-purity rule is intact (same
shape as `contributions: [...]` calling helper functions inline). The
framework calls `.register()` on the token during phase 1, which performs
the actual `runtimeRegistry.set(...)` write. `conversations`'s poller (in
`onReady`) sees `tmuxRuntime` because phase 1 finishes before phase 2 starts.

### Example 2 — `infra/events` (dual-purpose factory case)

**Before** — barrel pulls a side-effect-only import; the `defineJob` write
fires when the module is loaded:

```ts
// plugins/infra/plugins/events/server/index.ts
import "./internal/dispatch-job";   // <-- side effect: jobRegistry.set("events.dispatch", ...)

export default {
  id: "events",
  // ...
} satisfies ServerPluginDefinition;
```

```ts
// plugins/infra/plugins/events/server/internal/dispatch-job.ts
import { defineJob } from "@plugins/infra/plugins/jobs/server";

export const dispatchJob = defineJob({ name: "events.dispatch", ... });
//                       ^- factory used elsewhere in the plugin via .enqueue(...)
//                          but ALSO writes to jobRegistry at construction time
```

**After** — `defineJob` returns `JobFactory & Registration`; the same
`dispatchJob` value drives both `.enqueue` (factory role) and the framework's
register phase (Registration role):

```ts
// plugins/infra/plugins/events/server/index.ts
import type { ServerPluginDefinition } from "@server/types";
import { dispatchJob } from "./internal/dispatch-job";
import { jobsHooksRegistration } from "./internal/install-jobs-hooks";

export default {
  id: "events",
  // ...
  register: [
    dispatchJob,                // dual-purpose: factory + Registration
    jobsHooksRegistration,      // pure-write Registration
  ],
} satisfies ServerPluginDefinition;
```

```ts
// plugins/infra/plugins/events/server/internal/dispatch-job.ts (unchanged shape)
import { defineJob } from "@plugins/infra/plugins/jobs/server";

export const dispatchJob = defineJob({ name: "events.dispatch", ... });
// `.enqueue(...)` works at any point post-module-load (it doesn't read jobRegistry)
// `.register()` is called by the framework during phase 1
```

```ts
// plugins/infra/plugins/events/server/internal/install-jobs-hooks.ts
import { UNSAFE_installDurableHooks } from "@plugins/infra/plugins/jobs/server";

export const jobsHooksRegistration = UNSAFE_installDurableHooks({ ... });
//                                ^- returns Registration (pure), captured at module load
```

### What does *not* change

Most plugins look identical before/after. A typical web plugin like
`conversation-view`'s `vscode` sub-plugin has no side effects and gets no
`register` field. A typical server plugin with declarative routes and an
`onReady` (e.g. `build`) is also unchanged. The lifecycle field is opt-in.

## Plugin-boundaries checker update

`cli/src/checks/plugin-boundaries.ts:154-162` (rule **R5**) currently allows
default-export imports only in the framework files at lines 14-20. Two
options:

- **(A) Extend `FRAMEWORK_FILES`** to include `*.generated.ts`. Keeps R5
  conceptually identical: "default imports happen in registry files only,"
  but registry files are now generated.
- **(B) Drop R5 entirely.** With auto-discovery the human-written `plugins.ts`
  is a 1-line re-export and nobody imports plugin defaults manually. The rule
  loses meaning.

Pick **(A)** — the rule still has signal (it catches accidents like a feature
plugin defaulting another plugin's barrel) and the cost is trivial.

The `register` array contains pure value expressions
(`Runtime.define(...)`, `Mcp.tool(...)`, named imports of factories), so
**R3** (barrel purity) is satisfied without changes — same shape as the
existing `contributions: [...]` pattern. No checker change needed there.

## Symbol alternative for `Registration`

If publicly exposing a `register` method on factories ever becomes a
footgun (someone calls `dispatchJob.register()` themselves and double-trips
the duplicate guard), the interface can switch to a Symbol:

```ts
const APPLY = Symbol.for("plugin.apply");
interface Registration { [APPLY]: () => void | Promise<void>; }
```

Same logic, hidden from the factory's public API. The framework imports the
symbol; user code never sees it. Default to the visible `register` form
for simplicity; switch only if a real footgun shows up.

## Files modified

Framework:
- `plugin-core/types.ts` — add `Registration` interface; change `register?: Registration[]` on `PluginDefinition` (web).
- `server/src/types.ts:28` — add `register?: Registration[]` and `dependsOn?` to `ServerPluginDefinition`.
- `central/src/types.ts:20` — same for central.
- `server/src/index.ts` — split into register → migrate → onReady phases; topo-sort; loop over `Registration[]`.
- `central/src/index.ts` — same.
- `plugin-core/context.tsx:19-37` — invoke web `Registration.register()` tokens in `PluginProvider` mount (sync-only).

Registry helpers (lazy + rename):
- `plugins/infra/plugins/mcp/server/internal/mcp.ts:22-29` — rename `registerTool` → `tool`; return `Registration`. Update all call sites.
- `plugins/conversations/server/internal/runtime.ts:40-48` — rename `register` → `define`; return `Registration`. Update all call sites.
- `plugins/infra/plugins/jobs/server/internal/registry.ts:187+` — `defineJob` returns `JobFactory & Registration`. Move duplicate-name guard into the `register()` body.
- `plugins/infra/plugins/events/server/internal/event.ts:86-92` — `defineTriggerEvent` returns `{ table, event: EventHandle & Registration }`. Move `triggerTableRegistry.has` guard into `event.register()` body for consistency with `defineJob`.
- `plugins/infra/plugins/jobs/server/internal/step-ctx.ts:84-88` — `UNSAFE_installDurableHooks` returns `Registration`.

Codegen:
- `cli/src/docgen.ts` — extend `collectAllPlugins(root)` to emit `*.generated.ts` registry files.
- `cli/src/commands/build.ts` — call the new generator before the bun build step.
- `cli/src/checks/index.ts` — register new check `plugins-registry-in-sync`.
- `cli/src/checks/plugins-registry-in-sync.ts` (new) — fails if generated file would change.
- `cli/src/checks/plugin-boundaries.ts:14-20` — add `*.generated.ts` to `FRAMEWORK_FILES`.

Registry files (transition):
- `web/src/plugins.ts` → 1-line re-export from `plugins.generated.ts`.
- `server/src/plugins.ts` → same.
- `central/src/plugins.ts` → same.

Side-effect lifts (8 plugin server barrels listed in the table above).

## Migration order

1. Land `Registration` interface + `register: Registration[]` field type on `PluginDefinition` / `ServerPluginDefinition` / `CentralPluginDefinition`. Bootstrap topo-sorts and walks the empty arrays — no behavior change yet.
2. Convert each registry helper to lazy semantics one PR at a time:
   - `Mcp.registerTool` → `Mcp.tool` (mechanical rename + lazy).
   - `Runtime.register` → `Runtime.define` (mechanical rename + lazy).
   - `defineJob` (lazy + duplicate-guard moves to `register()`).
   - `defineTriggerEvent` (lazy + duplicate-guard moves to `event.register()`).
   - `UNSAFE_installDurableHooks` (lazy).
   Each rename PR updates the helper signature *and* every call site to use the new array form in one atomic change.
3. Remove the `internal/register.ts` / `internal/api-runtime.ts` shim files left behind by the v1 migration; replace with inline `register: [Runtime.define(...)]` in barrels.
4. Land docgen for `plugins.generated.ts` + the in-sync check; convert the three `plugins.ts` files to re-exports.
5. Update `plugin-boundaries.ts` `FRAMEWORK_FILES`.

## Verification

- **Unit / boot**: `./equin build` succeeds; gateway responds at
  `http://<worktree>.localhost:9000`. Server logs show all `Registration.register()`
  tokens firing before any `onReady`.
- **Topo-sort**: temporarily add a fake cycle in two plugins' `dependsOn`
  → confirm boot fails with a clear cycle message → revert.
- **MCP tool registry**: open a conversation, confirm `mcp__singularity__add_task`
  and `mcp__singularity__submit_conversation_summary` still work (proves
  `tasks` and `summary` register tokens executed before MCP serving).
- **Runtime registry**: launch a Sonnet conversation in a worktree, confirm
  it starts (proves `runtime-tmux` registered before `conversations`'s
  `onReady` poller).
- **Jobs**: trigger a push that fires the build job → confirm
  `pushes.landed → buildRunJob` still subscribes (proves `events`'s
  `dispatchJob`, `taskStatusChanged.event`, and `build`'s register/onReady
  interaction is intact).
- **Trigger registry**: confirm `trigger(...)` calls in `onReady` still find
  their event tables in `triggerTableRegistry` (regression check for the
  duplicate-guard relocation).
- **Checker**: run `./equin check` → all pass, including the new
  `plugins-registry-in-sync`.
- **Add a plugin**: scaffold a trivial new plugin, run `./equin build`,
  confirm it appears in `*.generated.ts` and is reachable from its slot.

## Open questions

- **Async `register()` tokens on web?** The React mount path is synchronous.
  Restrict web `Registration.register` to `() => void` (sync); central/server
  allow `() => void | Promise<void>`. Lean: sync-only on web.
- **Should `register()` receive a `ctx`?** Today the registry helpers don't
  need one. Lean: no `ctx` to start; add later if needed.
- **Generated file location**: `web/src/plugins.generated.ts` next to the
  re-export file vs. a hidden `web/src/__generated__/plugins.ts`. Lean:
  keep next to the re-export for visibility.
- **Visible `register` vs Symbol-keyed `[APPLY]`**: visible by default;
  switch to symbol only if duplicate-trip footguns surface in practice.
