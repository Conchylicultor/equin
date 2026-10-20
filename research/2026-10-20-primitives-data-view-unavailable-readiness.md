# DataView `readiness` takes a needsMachine read's `unavailable` arm

## Context

A `useLive` read of a `needsMachine` declaration adds a fourth arm,
`{ status: "unavailable"; message }` (`LiveUnavailable`,
`network/live/web/internal/use-live.ts`), under a transport with no computer.
DataView's `readiness` prop only takes the three-state `ResourceReadiness`
(`live-state/core/resource-status.ts`), so every DataView over such a read
branches by hand before rendering:

- `tasks/automations/web/components/automations-view.tsx` (`if (result.status === "unavailable") return <Placeholder>…`)
- `tasks/sidequest-autopilot/web/components/launch-list-section.tsx`
- `config_v2/settings/web/components/config-nav.tsx`

Every future machine-only DataView would repeat it (or forget it — and then not
compile only by luck of the type). Goal: `readiness={result}` takes the read
itself, whatever arms it has, and DataView owns the unavailable rendering.

The same arm is also declared twice structurally today: `LiveUnavailable`
(network/live web) and `GateUnavailable` (live-state web, "network/live's
`LiveUnavailable`, structurally"). DataView's prop type lives in `core/`, which
can import neither web barrel.

## Design

1. **One definition of the arm, in `live-state/core`.** Add
   `ResourceUnavailable { status: "unavailable"; message: string }` to
   `resource-status.ts` (exported from the core barrel), next to
   `ResourceReadiness`. `GateUnavailable` is deleted and its users
   (`resource-utils.ts`, `resource-view.tsx`, `claude-code-health.ts`, the test)
   import `ResourceUnavailable`; `LiveUnavailable` in network/live becomes
   `type LiveUnavailable = ResourceUnavailable` (keeps its doc, one shape).

2. **DataView prop widens.** `DataViewInMemoryRows.readiness?:
   ResourceReadiness | ResourceUnavailable` (`data-view/core/internal/types.ts`),
   doc: "`unavailable` renders its `message` in place of the whole view — no
   view controls, since nothing will ever arrive to act on".

3. **The shell renders it, not the body.** An unavailable read is not a body
   state (loading/error keep a toolbar because rows will/may come); it is the
   whole surface not existing here — exactly what the call sites render today
   (no search box over nothing). `DataViewShellFrame`
   (`data-view/web/components/data-view.tsx`) gets an `unavailable?: string`
   prop and, before the `!viewModel.ready` branch, returns
   `withoutInstance(<Placeholder>{unavailable}</Placeholder>)` — the existing
   stand-in chrome (title / actions / creators, hosted frame, sections) so a
   surface's title still frames the message. `DataView` passes
   `readiness?.status === "unavailable" ? readiness.message : undefined`.

4. **The body only ever sees the three states.** `DataViewBody` /
   `DataViewSectionsBody` get `readiness` narrowed
   (`Exclude<…, ResourceUnavailable>`) — DataView narrows once at the top and
   passes the narrowed value, so `resolveBodyState` keeps its
   `ResourceReadiness` input and nothing downstream gains an arm it can't be in.
   If the body's prop type is `DataViewProps`, introduce the narrowed prop type
   there rather than an unreachable runtime branch.

5. **Call sites drop their branch.** The three files above lose the
   `if (… === "unavailable") return <Placeholder>` and pass the read as is.
   In the launch list the header already hides itself (its `entry` folds
   `unavailable → null`); confirm the wrapping `Stack` still reads right.
   `DataViewSwitcher`: if its sources take `readiness`, give them the same
   treatment; otherwise leave it.

No new UI: the rendered message and Placeholder are unchanged (the shell's
title band now frames it where a title was given), so no prototype.

## Files

- `plugins/primitives/plugins/live-state/core/resource-status.ts`, `core/index.ts`
- `plugins/primitives/plugins/live-state/web/resource-utils.ts`, `web/index.ts`, `web/components/resource-view.tsx`, `web/resource-utils.test.ts`
- `plugins/infra/plugins/claude-cli/plugins/availability/web/internal/claude-code-health.ts`
- `plugins/network/plugins/live/web/internal/use-live.ts`
- `plugins/primitives/plugins/data-view/core/internal/types.ts`
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` (+ body prop typing in `data-view-body.tsx` if needed)
- the three call sites; `data-view/CLAUDE.md` (readiness paragraph)

## Verification

- New jsdom test in `data-view/web/__tests__/`: `readiness={{status:"unavailable",message}}`
  renders the message, no search input, no rows; title still shown.
- `./singularity test plugins/primitives/plugins/data-view plugins/primitives/plugins/live-state`
- `./singularity build` (type-check + lint), then a screenshot of Automations
  on the worktree build (portable path renders normally).
