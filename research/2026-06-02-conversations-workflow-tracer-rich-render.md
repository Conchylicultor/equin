# Rich rendering of the Workflow tool call via trace-execution

## Context

The Workflow tool's `input.script` is plain async JS (injected globals, not imports) describing a
multi-agent orchestration: `agent()`, `parallel()`, `pipeline()`, `phase()`, plus `args`/`budget`/
`workflow()`. Today the jsonl-viewer workflow renderer
(`.../tool-call/plugins/workflow/web/components/workflow-tool-view.tsx`) only shows meta (name,
description, numbered phases) parsed by regex, the raw script, and run/task ids. We want a rich
swimlane/DAG view: per-phase agent nodes, concurrency groups, and data-flow dependency edges.

The chosen approach is to **trace-execute** the script with mocked hooks (no AST/regex) and record a
graph. This doc validates that approach, specifies the data model + component, lays out files, and
gives a verification plan. Tier-0 (existing `parseWorkflowMeta`) stays as the always-works fallback.

### Scope (v1) — confirmed decisions

- **Trace runs on the MAIN THREAD** (try/catch + iteration tripwire). No Web Worker in v1 — see §2 for
  why the tripwire is sufficient and what the documented limitation is.
- **Swimlane view only.** The optional `@xyflow/react` + `dagre` graph toggle (lifted from
  `task-graph`) is explicitly deferred to v2; both deps are already in the root `package.json` so it's
  a self-contained future addition.
- Three render tiers, degrading gracefully: **(1)** traced swimlane graph (rich) → **(0)** existing
  `meta` regex view (name/description/phases) as the always-works fallback when the trace throws or
  there's no inline `script`.

---

## 1. Tracer / Proxy design — validation and hole-by-hole hardening

Verdict: the Proxy-handle + sentinel-scan approach is sound, but several real-world shapes will
throw or mislead unless the Proxy is built defensively. The governing principle must be:
**every trap returns something usable and NEVER throws; "I can't model this precisely" degrades to
`dynamic:true` on the representative node, not an exception.**

The handle is a function-target Proxy (target must be a function so the handle is callable AND
constructible without throwing): `new Proxy(function(){}, traps)`. It carries a hidden `nodeId`.

Risky shapes and the exact trap behaviour that keeps them graceful:

- **`toString` / `Symbol.toPrimitive` / `valueOf`** → return the sentinel ` WF:<id> ` (with the
  surrounding spaces, so it survives concatenation and `${}`). `Symbol.toPrimitive` must accept the
  `hint` arg and ALWAYS return the string sentinel (even for hint `"number"`), so numeric coercion
  (see below) yields `NaN` rather than throwing.
- **`.summary`, `.findings`, chained member access** → `get` trap returns a NEW handle bound to the
  SAME `nodeId` (so a downstream prompt referencing `foundation.summary` still resolves to the
  foundation node). Cache child handles per-key on the parent to keep identity stable.
- **`then`** → `get('then')` returns `undefined`. This makes `await handle` resolve to the handle
  itself (await on a non-thenable is identity). Confirmed correct. Do the same for `catch`/`finally`
  defensively so `handle.catch(...)` (rare) doesn't blow up — return a no-op function handle.
- **Array methods (`map`/`flatMap`/`filter`/`forEach`/`reduce`/`some`/`every`/`join`/`slice`/`concat`)**
  → `get` returns a function that invokes the callback (if any) ONCE with `(childHandle, 0, [])`,
  sets `dynamic:true` on the node, and returns a sensible shape:
  - `map`/`flatMap`/`filter`/`slice`/`concat` → return a real array `[childHandle]` (length 1) so
    downstream `.length`, indexing `[0]`, and re-`.map` keep working.
  - `forEach` → return `undefined`.
  - `reduce` → call reducer once with `(initialOrChildHandle, childHandle, 0, [])`, return its result.
  - `join` → return the child handle's sentinel string (so template literals embedding
    `${xs.map(...).join('\n')}` still carry ONE dep edge).
  - `some`/`every`/`includes` → return `false`/`true` respectively but harmless; pick values that
    keep loops bounded (`some`→false so `while(!xs.some())` doesn't infinite-loop... but the
    iteration tripwire is the real backstop here, see below).
- **`.filter(Boolean)`** → `filter` ignores a non-function predicate (Boolean is a function so it's
  fine; it's called once with the child handle, returns the child handle which is truthy → array
  `[childHandle]`). The key risk is `filter` being passed `Boolean` and us trying to `.call` it —
  guard: if predicate is callable call it, else keep the element. Never throw.
- **`parallel(arr.map(() => () => agent(...)))` (thunks returning promises)** → `parallel` receives
  an array of thunks. For each thunk: call it; the thunk returns the result of `agent()` which is a
  handle (agent is sync-returning a handle, NOT a real promise — see §2). `parallel` tags every
  handle produced during that thunk's execution into one concurrency group and returns a real array
  of those handles. Because `arr` here is itself a traced `.map`, the array has length 1 → parallel
  sees 1 thunk → records 1 representative node with `dynamic:true` and `groupKind:"parallel"`. That
  is the correct graceful degradation (we can't know fan-out width statically).
- **Nested `parallel` inside `parallel`** → groups must be a STACK, not a single "current group".
  `parallel` pushes a new group, runs thunks, pops. Inner agents get the innermost group id; record
  parent-group on each group so the component can nest. Avoid one flat `currentGroup` global.
- **`pipeline(items, ...stages)` with stage callbacks `(prev, item, index)`** → run `items` (often a
  traced array → length-1 representative, or a literal array like `DIMENSIONS`). For a literal array,
  iterate REAL items but cap at, say, 6 to avoid huge graphs; mark `dynamic` if capped. Call each
  stage with `(prevHandle, itemValue, index)`; `prevHandle` is the handle from the previous stage.
  Stages that internally call `parallel(review.findings.map(...))` are handled by the array+parallel
  rules above. Each stage records a node; edges chain stage[i-1]→stage[i].
- **Template literals `${x.map(...).join()}`** → resolved by the array-method rules: `.map` returns
  `[childHandle]`, `.join` returns the child's sentinel. The final string contains ` WF:<id> ` which
  the post-scan turns into a dep edge to that node. One edge, not N — acceptable.
- **Numeric / boolean coercion in conditions** (`while (bugs.length < 10)`, `budget.remaining() > 50000`)
  → `bugs` is a real array we control (workflow code does `bugs.push(...r.bugs)`; `r.bugs` is a
  handle whose spread yields nothing — see iterator — so `bugs` stays empty, `.length` is 0, loop
  body runs once or repeatedly). This is the #1 infinite-loop source. The handle's numeric coercion
  → `NaN`; `NaN < 10` is `false`, `NaN > 50000` is `false`. So conditions comparing a HANDLE numeric
  are false and terminate. But `bugs.length` is a real `0` that never grows → `0 < 10` stays true →
  infinite loop. **This is why the iteration tripwire is mandatory and the dominant safety
  mechanism**, not an edge case.
- **`budget`** = `{ total: null, spent: () => 0, remaining: () => Infinity }`. `remaining() > 50000`
  → `Infinity > 50000` → true → `while (budget.remaining() > 50000)` is an infinite loop → again the
  tripwire catches it. (Choosing `remaining()` = `0` instead would terminate the loop but under-count
  nodes; `Infinity` + tripwire gives a representative-but-truncated graph, which is more honest. Pick
  `Infinity` and rely on the tripwire.)
- **`JSON` / `Math` / `Array` / `Object` / `String` / `Number` / `Promise` usage** → these are
  ambient globals inside `AsyncFunction`; do NOT shadow them. But `JSON.stringify(handle)` calls
  `handle.toJSON` then enumerates own keys. Provide `get('toJSON')` → function returning the sentinel
  string, so `JSON.stringify` emits `" WF:<id> "` (still scannable). `ownKeys`/`getOwnPropertyDescriptor`
  traps: return `[]` / undefined so enumeration/spread-into-object yields nothing and never throws.
- **`Symbol.iterator`** → return a generator that yields NOTHING. So `[...handle]` is `[]`,
  `for (const x of handle)` runs zero times, and `const [a,b] = handle` gives `a=b=undefined`. This
  is the spread-empties behaviour the brief wants. Also define `Symbol.asyncIterator` the same way so
  `for await (const x of handle)` is safe.
- **`new Handle()` / construct trap** → return a fresh child handle (don't throw).
- **`delete`, `set`** → `set` records nothing, returns true; `defineProperty` returns true. Never
  throw on assignment (`handle.x = 1`).

Tripwire (the real safety net, more important than the worker): a module-level counter increments on
every `agent()` call AND every node creation. On exceeding caps (`MAX_AGENTS=200`, `MAX_NODES=64`)
throw a sentinel `TruncatedError`; the trace driver catches ONLY that error, marks `truncated:true`,
and returns the partial graph. A separate `try/catch` around the whole `AsyncFunction` invocation
catches ALL other errors and falls back to tier-0.

**Over-engineering call-outs:**
- `reduce`/`some`/`every`/`includes` support is probably unused by real scripts — implement them as
  thin no-throw shims but don't gold-plate.
- The sentinel-replacement-for-preview ("replace ` WF:<id> ` with the referenced node's label") is
  nice-to-have; the dep EDGE is what matters. Keep the raw prompt (sentinels stripped to the label or
  to `«foundation»`) for the preview and store the full original prompt for the side pane.

---

## 2. Web Worker vs main-thread — DECIDED: main-thread

**Decision (confirmed with the user): main-thread execution inside `try/catch`, guarded by the
iteration tripwire ONLY. No Web Worker in v1.** Reasoning:

- This would be the repo's FIRST worker AND first dynamic-eval. Two novel infrastructure risks at
  once. The worker's only unique value over the tripwire is killing a PATHOLOGICAL SYNCHRONOUS
  infinite loop (`while(true){}` with no `await`). Our scripts always `await agent()` (or `parallel`/
  `pipeline`) inside their loops, and the tripwire fires on `agent()`/node-count — so for every
  realistic script the tripwire terminates first. The worker guards a case our inputs don't produce.
- A truly sync infinite loop with NO agent call and NO node creation (e.g. `while(true){ x++ }`) WOULD
  hang the main thread and the tripwire would never fire. Mitigation without a worker: also increment
  the tripwire counter inside the array-method shims and member `get` traps with a separate
  `MAX_OPS` cap is unreliable (a pure `while(true){x++}` touches no handle). Honest mitigation: add a
  wall-clock check — the AsyncFunction is async, so between `await` points we yield to microtasks;
  but a sync loop never yields. The pragmatic answer: accept this as a known limitation for v1; such
  a script is malformed and would be caught by tier-0 fallback only if it throws (it won't, it
  hangs). Document it. If it ever bites, THEN add the worker as tier-1.5.
- Keeping the trace synchronous-enough without `terminate()`: make `agent`/`parallel`/`pipeline`
  return SYNCHRONOUSLY (a handle / array of handles), NOT promises. `await <handle>` then resolves on
  the microtask queue immediately (await of a non-thenable schedules a microtask and continues). So
  the whole AsyncFunction settles within a few microtask ticks with zero real async work. The driver:
  `const result = await asyncFn(...mocks); postProcess();`. Because everything is microtask-resolved,
  there is no multi-ms gap to need a terminate backstop. Wrap the whole thing in `try/catch`; on
  `TruncatedError` keep partial graph + `truncated:true`; on any other throw → tier-0.

If a worker is later justified: `new Worker(new URL("./tracer.worker.ts", import.meta.url),
{type:"module"})` is natively supported by the Vite 6 config at `plugins/framework/plugins/web-core/`
(confirmed: standard `@vitejs/plugin-react`, no CSP, no `unsafe-eval` restriction anywhere in repo).
But that is explicitly OUT of v1 scope.

Construction of the function: strip a single leading `export ` from `export const meta` so the body
is valid, then
`new AsyncFunction('agent','parallel','pipeline','phase','log','args','budget','workflow', body)`.
Note `AsyncFunction` must be obtained via `Object.getPrototypeOf(async function(){}).constructor`
(there is no global `AsyncFunction` binding).

---

## 3. Data model + component

### Emitted types (tracer → React), live in `web/internal/trace-types.ts`

```ts
export type ModelTier = "opus" | "sonnet" | "haiku" | string;

export interface TracedNode {
  id: string;                 // "n0", "n1", ... (== WF:<id> sentinel id)
  kind: "agent" | "workflow"; // workflow() nested call vs agent()
  label: string;              // opts.label ?? first words of prompt
  phase?: string;             // active phase title at record time
  model?: ModelTier;          // opts.model
  promptPreview: string;      // sentinels replaced by «label», truncated
  prompt: string;             // full original prompt (for side pane)
  groupId?: string;           // concurrency group membership
  deps: string[];             // node ids referenced in this node's prompt
  dynamic?: boolean;          // representative node for a runtime-sized fan-out
}

export interface Group {
  id: string;
  kind: "parallel" | "pipeline";
  parentGroupId?: string;     // nested groups
  stageIndex?: number;        // pipeline: which stage column
  dynamic?: boolean;          // fan-out width unknown
}

export interface Phase { title: string; detail?: string; }

export interface TracedGraph {
  phases: Phase[];            // ordering: meta.phases first, then phase() calls
                              //   not already present, in first-appearance order
  nodes: TracedNode[];        // insertion order == execution order
  groups: Group[];
  truncated: boolean;
}

export type TraceStatus = "tracing" | "ready" | "fallback";
```

### Phase ordering
Seed `phases` from `meta.phases` (parsed by existing `parseWorkflowMeta`). As `phase(t)` and
`agent({phase})` are seen, append any title not already present, preserving first-appearance order.
Nodes without a phase go in an implicit leading "" bucket rendered with no header.

### Component rendering (swimlane, the v1 primary view)
Group nodes by phase (in `phases` order). Within a phase, walk nodes in order and bucket consecutive
nodes by `groupId`:
- **single** (no group) → stacked card, full width.
- **parallel group** → a row with header `⇉ parallel ×N` (N = node count, or `×?` if `dynamic`),
  children laid side-by-side (flex-wrap). Nested parallel → nested bordered row.
- **pipeline group** → columns by `stageIndex` with `→` separators; each column stacks its nodes.

Each node card: model badge (reuse EXACT palette — opus amber / sonnet sky / haiku emerald, already
allowlisted), `label`, truncated `promptPreview`, a `dynamic` "×N runtime" chip if set. Click → open
the workflow-node side pane (full prompt as Markdown).

### Banners
- `dynamic` anywhere → subtle info note "Some steps fan out at runtime; counts are representative."
- `truncated` → warning banner "Graph truncated at N nodes — view full script below." Always keep the
  existing collapsible script section beneath the graph.

### Dep-edge focus highlight
In swimlane mode (no react-flow), hovering a node sets `hoverId`; compute `deps` (node.deps) and
`dependents` (nodes whose `deps` include hoverId). Dim all others to ~40% opacity, outline deps in
one accent and dependents in another, and render a small "depends on: «labels»" caption. This gives
the data-flow story without needing edges drawn. (The optional ReactFlow LR-dagre view — lifted from
`plugins/tasks/plugins/task-graph/web/components/task-graph.tsx`, both deps already in root
package.json — is a v2 toggle, not v1.)

---

## 4. File structure (extends existing workflow plugin)

Base: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/workflow/`

CREATE:
- `web/internal/trace-types.ts` — the interfaces above.
- `web/internal/handle.ts` — the Proxy handle factory (all traps from §1).
- `web/internal/trace-workflow.ts` — builds the AsyncFunction, injects mocks (`agent`/`parallel`/
  `pipeline`/`phase`/`log`/`args`/`budget`/`workflow`), runs it in `try/catch` with the tripwire,
  returns `TracedGraph | null`. Pure, sync-ish (resolves via microtasks), framework-free.
- `web/internal/use-workflow-trace.ts` — `useWorkflowTrace(script, meta)` hook: `useMemo` over the
  script → runs `traceWorkflow`; returns `{ graph, status }`. `status:"ready"` if graph non-null,
  `"fallback"` if null/threw. (`"tracing"` is effectively instantaneous on main thread; keep the
  union for future worker compatibility — initial render can show `"tracing"` for one tick via a
  `useState`+`useEffect` if desired, but a synchronous `useMemo` returning `ready`/`fallback` is
  simpler and fine.)
- `web/components/workflow-graph.tsx` — the swimlane component consuming `TracedGraph` (phases,
  groups, nodes, banners, hover-highlight).
- `web/components/workflow-node-card.tsx` — single node card + model badge (reuse palette).
- `web/components/workflow-node-pane.tsx` — side pane body (full prompt via `Markdown`).
- `web/panes.ts` — `Pane.define({ id:"workflow-node", segment:"workflow-node/:toolUseId/:nodeId",
  input:type<{convId:string}>(), component, chrome:{history:false}, width:600, resolve:false })`.

MODIFY:
- `web/components/workflow-tool-view.tsx` — call `useWorkflowTrace`; if `status==="ready"` render
  `<WorkflowGraph>` above the existing collapsible script; else render today's meta+phases view
  unchanged (tier-0). Wire node-click → `useOpenPane()(workflowNodePane, {toolUseId, nodeId},
  {mode:"push", input:{convId}})`, `convId` from `conversationPane.useChainEntry()?.params.convId`.
- `web/index.ts` — add `Pane.Register({ pane: workflowNodePane })` to contributions.
- (no `package.json` change — leaf package stays `{name, private, version}`; xyflow/dagre are root
  deps and only needed if/when the v2 ReactFlow toggle is added.)

The worker file + AsyncFunction: AsyncFunction lives in `web/internal/trace-workflow.ts` (main
thread). NO worker file in v1.

---

## 5. Verification plan

Build + checks:
- `./equin build` (runs web build + tsc + checks). Confirm `no-hardcoded-colors` passes — the
  workflow component path is ALREADY in `ALLOWED_PATHS`
  (`.../no-hardcoded-colors/check/index.ts:34`); if new color-bearing component files are added under
  a different filename, add those paths to the allowlist too (or keep all color usage inside
  `workflow-tool-view.tsx` / re-use the agent badge). Verify plugin-boundaries + plugins-doc-in-sync.

Unit (vitest, `bun run test` in web-core): pure-function tests on `traceWorkflow` with fixture
scripts — exercise each §1 shape:
1. The canonical foundation→parallel→closeout example → expect phases ordered, one parallel group,
   deps from closeout/migrations back to foundation.
2. `while (bugs.length < 10) { bugs.push(...await agent()) }` → expect `truncated:true`, ≤MAX_NODES.
3. `while (budget.remaining() > 50000) {...}` → `truncated:true`.
4. `pipeline(DIMENSIONS, d=>agent(...), r=>parallel(r.findings.map(f=>()=>agent(...))))` → pipeline
   group with 2 stage columns, inner parallel `dynamic:true`.
5. `${x.map(m=>m).join('\n')}` in a prompt → exactly one dep edge.
6. Malformed script (syntax error / `throw` at top) → `traceWorkflow` returns null → status fallback.
7. `scriptPath`-only invocation, no inline `script` → `script===""` → tier-0 path (scriptPath box),
   never calls the tracer.

End-to-end (Playwright screenshot against a real conversation):
- Real Workflow tool calls exist in on-disk transcripts, e.g.
  `~/.claude/projects/-Users-epot...att-1778616713-jmzb/2473fdaf-...jsonl` (found via
  `grep -rl 'Workflow' ~/.claude/projects`). To view one: the conversation must be known to the app
  (a row in the conversations list). Easiest path: open the conversations sidebar, find a
  conversation whose transcript contains a Workflow call (or seed one by resuming/importing the
  transcript's session id), then navigate to `http://<ns>.localhost:9000/c/<convId>`.
- Capture with the existing harness:
  `bun e2e/screenshot.mjs --url http://equin.localhost:9000/c/<convId> --out /tmp/wf` then
  scroll/locate the Workflow card. Extend the script to click a node card and screenshot the opened
  `workflow-node` pane (mirror `screenshot-conversation-with-file.mjs` click loop). Visually confirm:
  swimlane phases, the `⇉ parallel ×N` row, model badges, hover-dim highlight, and the side pane
  Markdown prompt.
- Also screenshot the truncated-loop and malformed cases by seeding small synthetic transcripts if no
  real ones exist, OR rely on the vitest fixtures for those (component snapshot via a Storybook-less
  manual render is overkill — vitest on the pure tracer + one real e2e screenshot is sufficient).

## Critical files for implementation
- plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/workflow/web/components/workflow-tool-view.tsx
- plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/workflow/web/internal/parse-workflow.ts
- plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/agent/web/panes.ts
- plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/agent/web/components/agent-tool-view.tsx
- plugins/framework/plugins/tooling/plugins/checks/plugins/no-hardcoded-colors/check/index.ts
