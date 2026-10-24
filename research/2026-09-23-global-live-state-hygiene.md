# Live-state hygiene — four small fixes from the live-resources audit (§10.3)

## Context

The live-resources audit (page block-fbee0e5f…, and
`research/2026-09-23-global-live-resources-open-questions.md` §10) found four
independent problems. Each has a local fix, and each also has a structural cause
that lets it come back. This plan fixes both halves for all four.

---

## 1. Window/point descriptor factories: one way to declare a bounded resource

**Today.** `primitives/live-state/core/window.ts` exports two factories,
`windowResourceDescriptor` and `pointResourceDescriptor`. They are re-exported from
the core and web barrels, and live-state's CLAUDE.md calls them the **default for
new resources**. Their only callers are the query-resource wrappers
(`windowQueryResourceDescriptor` / `pointQueryResourceDescriptor` in
`infra/query-resource/core/internal/window-descriptor.ts`), which add `queryPk` so
the server can check the key field at boot. A raw factory call skips that check, and
nothing on the server can serve a raw descriptor anyway.

**Fix (rung 1: the wrong form can no longer be written).** Move the two factory
bodies out of live-state and into query-resource's `window-descriptor.ts`, inlined
into the two wrappers. They keep building on `keyedResourceDescriptor`, which stays
public.

- Live-state keeps the **types**: `WindowResourceDescriptor`,
  `PointResourceDescriptor`, `WindowParams`, `PointParams`, `WindowSelector`.
  `window-hooks.ts` only imports these types, and `useWindowResource` /
  `usePointResource` stay generic. `window.ts` shrinks to the types and the shared
  limit assert, if a type needs it.
- Remove the two value exports from `live-state/core/index.ts` and
  `live-state/web/index.ts`.
- `resource-vocabulary/core/vocabulary.ts`: delete the `windowResourceDescriptor` and
  `pointResourceDescriptor` entries. The key set is derived from the barrels, so tsc
  forces this. Update the "vocabulary owner" exemption in the resources facet
  (`parse-resources.ts` `buildDescriptorIndex`) so only query-resource implements a
  wrapper. Adjust the fixtures in `parse-resources.test.ts` and
  `eager-tier-gen.test.ts` that spell the raw names.
- Tests: `live-state/core/window.test.ts` (codec tests) moves to
  `query-resource/core/`. `live-state/web/__tests__/window-hooks.test.tsx` needs a
  descriptor fixture. It cannot import query-resource, because that would be a cycle.
  So it builds a small fixture that satisfies the interface, from
  `keyedResourceDescriptor` plus a stub `.window` / `.point` codec, in a
  `live-state/web/testing` helper or inline.
- Docs: rewrite the "Bounded windows and point reads" section of
  `primitives/live-state/CLAUDE.md`. The default becomes
  `windowQueryResourceDescriptor` / `pointQueryResourceDescriptor`, paired with
  `windowQueryResource` on the server. Live-state owns only the types and hooks. Add a
  line to the bounded-contract research doc saying the factories moved.

## 2. Allow-monitor chip: pushed from the file system, not polled

**Today.** The red "BYPASS ACTIVE" chip calls `GET /api/conversations/:id/allow-files`
every 3 s. There are two more problems:

- **Hardcoded list that has drifted.** The handler checks only `.allow-main` and
  `.allow-postgres`. The guards also honour `.allow-bun-script`, `.allow-git-push` and
  `.allow-foreground-ops`, so three kinds of bypass never show the chip.
- **No guardrail.** Nothing flags `refetchInterval`. Three other sites use it, all
  debug panels: `debug/health-monitor`, `debug/read-set` and
  `debug/live-state-churn/emit`.

**Fix.**

1. **One list of bypass files, taken from the guards.** Put `bypassToken` on the
   `Guard` object that `defineGuard` returns (today it is only used inside the
   closure). Export `BYPASS_TOKENS` from `guards/core`, computed from `GUARDS`
   (unique, sorted). Allow-monitor imports it, so a new guard's bypass file shows up
   in the chip with no edit here. (Check that the `guards/core` import graph is light
   enough for a server plugin. `infra/paths/check` already imports it.)
2. **A pushed, per-conversation resource**, modelled on `editedFilesResource`
   (`conversation-view/plugins/code/server/internal/edited-files-resource.ts`):
   - `allow-monitor/core/resources.ts`: a descriptor for `"allow-files"` whose schema
     is `{ allowFiles: string[] }`, with params `{ id }`.
   - Server: `defineExternalResource({ key, mode: "push", schema, loader, onFirstSubscribe, onLastUnsubscribe })`.
     The loader is today's handler body with the token list swapped for
     `BYPASS_TOKENS`. `onFirstSubscribe({id})` resolves the conversation's worktree and
     opens a `createFileWatcher` (`infra/file-watcher`) on its root. The watcher
     ignores every subdirectory (`**/*/**`), and its `onChange` runs `notify({id})`
     only when a changed path's basename is in `BYPASS_TOKENS`.
     `onLastUnsubscribe` stops the watcher. Keep a `Map<id, stop>` the same way
     edited-files does.
   - Web: `useResource(allowFilesResource, { id: convId })`. Render nothing while it
     is pending, the same as today's no-data case, since the chip is an alarm and not
     a data display. Pass the pending state through a loading-aware read so that
     `no-pending-data-collapse` passes.
   - Delete `shared/endpoints.ts`, the route, and the handler. Rewrite the prose in
     allow-monitor's CLAUDE.md ("Polls every 3 seconds…").
3. **Guardrail (rung 3): a lint rule `no-refetch-interval`**, in a new lint sub-plugin
   under `framework/tooling/lint/plugins/`. It reports any object-literal property
   named `refetchInterval`, with the message "polling app data — use a live-state
   resource (push) instead". The three debug panels get
   `// eslint-disable-next-line … -- <reason>` (they poll process internals that have
   no change signal). The disable comment's reason is the audit trail. The rule does
   not try to audit all 105 `useEndpoint` sites for shadowing a resource; that is out
   of scope.

## 3. Networking: one reconnect backoff

**Today.** There are four copies, not three, each with its own jitter:

| file | schedule | jitter |
|---|---|---|
| `fetch-with-retry.ts` | `backoffMs·2^n` | 0.85–1.15× |
| `shared-websocket.ts` | table `[500,1000,2000,5000]` | 0.5–1.5× |
| `use-reconnecting-ws.ts` | same table (copy) | 0.5–1.0× ("equal jitter") |
| `reconnecting-event-source.ts` | same table (copy) | **none** |

Each reconnecting transport also hand-rolls the same `attempt` counter, the
`retryTimer`, and the clear-on-close/reset-on-open logic.

**Fix.** `packages/retry/core` already has `DelayStrategy`, `exponential` and
`withJitter`. Reuse them rather than adding a fifth formula.

- New `networking/web/reconnect-backoff.ts` (internal):
  - `RECONNECT_DELAY: DelayStrategy = withJitter(exponential({ initial: 500, max: 5000 }), 1)`.
    That is 0.5–1.5×, the band the shared-socket comment argues for. The schedule
    becomes 500/1000/2000/4000/5000 ms instead of 500/1000/2000/5000 ms, which is
    harmless.
  - `class ReconnectSchedule`, holding `attempt`, `schedule(fn): number` (returns the
    new attempt number, for `publishNetDiag`), `reset()` (on open), `cancel()` (on
    close/dispose) and `get isFirst`. The timer lives here, so no transport holds a
    raw `setTimeout` for reconnects.
- `shared-websocket.ts`, `reconnecting-event-source.ts` and `use-reconnecting-ws.ts`
  use `ReconnectSchedule`. Delete the three `BACKOFF_MS` tables and the inline jitter.
  The event stream gains jitter as a side effect.
- `fetch-with-retry.ts`:
  `withJitter(exponential({ initial: backoffMs, max: Infinity }), 0.3)`, which gives
  the same numbers as today through the shared primitive.
- Tests: a small `reconnect-backoff.test.ts` (delay bounds per attempt,
  reset/cancel). Existing `shared-websocket.test.ts` must still pass (check whether it
  stubs `Math.random` or the table).

## 4. Docs "Resources:" list: resolve `key: X.key`, never drop silently

**Today.** In `plugin-meta/facets/plugins/resources/facet/parse-resources.ts`,
`resolveRegisterCall`'s flat-object branch (`defineResource({ key: …, … })`) returns
`null` when `key` is not a string literal. `parseRegisterCalls` then skips it with no
signal. That is how 14 resources vanish (8 Sonata, `pages`, `page-blocks`,
`page-links`, `page-backlinks`, `data-view-custom-values`, `data-view-row-order`). All
14 use `key: <descriptor>.key`, where the descriptor is a literal-keyed
`resourceDescriptor` in the plugin's own core/shared or in another plugin. The same
module's descriptor-argument branch already resolves an identifier through
`parseFileBindings`, the per-plugin descriptor index and `resolveImported`, and throws
when it cannot. The flat branch never uses that path.

**Fix (make the drop loud, then resolve).**

- In the flat branch, when `parseStringField(…, "key")` is `dynamic` and its expression
  matches `^<ident>\.key$`, resolve `<ident>` through the same helper the descriptor
  branch uses. Extract that helper so both branches share one function. The key comes
  from the resolved descriptor.
- Any other non-literal key (template interpolation, a call, a bare constant, or an
  identifier that cannot be resolved) **throws**, with file:line and the expression.
  This follows the module's documented "resolves or throws" contract. Only a truly
  **absent** `key` keeps returning `null`, as the existing test covers. If some real
  site uses a form that cannot be resolved, it fails at build and gets fixed at the
  site. It is not skipped.
- Update the stale comment ("fall through to `null` … drop") and the facet's CLAUDE.md.
- Tests in `parse-resources.test.ts`:
  - `key: localDesc.key`, where the descriptor is in the same file.
  - `key: imported.key` through the import map, both same-plugin and cross-plugin.
  - `` key: `${x}` `` and `key: SOME_CONST` both throw.
- Regenerate the docs (the build does it). All 14 keys must appear in
  `docs/plugins-details.md`.

---

## Critical files

- `plugins/primitives/plugins/live-state/{core/window.ts,core/index.ts,web/index.ts,CLAUDE.md,web/__tests__/window-hooks.test.tsx}`
- `plugins/infra/plugins/query-resource/core/internal/window-descriptor.ts`
- `plugins/framework/plugins/tooling/plugins/resource-vocabulary/core/vocabulary.ts`
- `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts` (+ test)
- `plugins/conversations/plugins/conversation-view/plugins/allow-monitor/**`
- `plugins/framework/plugins/tooling/plugins/guards/core/{define-guard.ts,types.ts,index.ts}`
- new lint sub-plugin `plugins/framework/plugins/tooling/plugins/lint/plugins/<no-polling>/`
- `plugins/primitives/plugins/networking/web/{reconnect-backoff.ts,shared-websocket.ts,reconnecting-event-source.ts,use-reconnecting-ws.ts,fetch-with-retry.ts}`

## Verification

- `./equin test plugins/primitives/plugins/live-state plugins/infra/plugins/query-resource plugins/primitives/plugins/networking plugins/plugin-meta/plugins/facets/plugins/resources`
- `./equin build` (in the background, then await). Type-check, the new lint
  rule, `plugins-doc-in-sync` and boundaries all pass. `rg` shows that all 14 keys now
  appear in `docs/plugins-details.md`, and that `windowResourceDescriptor` no longer
  appears in any barrel.
- Allow-monitor end to end, on the deployed worktree: open a conversation whose
  worktree is known, `touch <wt>/.allow-git-push`, and the chip appears with no
  polling. Check the browser network tab: no `/allow-files` requests. Then `rm` the
  file and the chip disappears. Screenshot both states with `e2e-harness`'s
  `screenshot.ts`.
- Networking: after the build, restart the backend and watch the app reconnect. The
  health dot recovers and `ws-reconnect-scheduled` diagnostics show spread-out delays.
