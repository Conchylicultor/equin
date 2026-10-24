# Live-state: stop swallowing client-side parse errors

## Context

The original goal was to eliminate a silent-failure class: when a required field
is added to a live-state resource's Zod schema but the server loader's
hand-picked `.select({})` projection isn't updated, every row failed Zod
validation and the surface silently showed empty (the bell showing
"No notifications" with nothing surfaced).

Investigation found **two swallow points**: (1) the server never validated loader
output against the schema, and (2) the client parse error was swallowed by an
unprotected `onmessage` handler.

**Swallow point (1) is now fixed.** The prerequisite task
(`task-1780919135430-net2kh`) did the server-side work, which landed on `main`:
- `580b9619c feat(live-state): make resource schema mandatory + validate loader output on the server`
- `39d04ddff refactor(live-state): unify duplicated resource runtime into shared createResourceRuntime factory`

`schema` is now **required** on every resource, and loader output is parsed
against it at the single `timedLoad` chokepoint (in
`@plugins/framework/plugins/resource-runtime/core`, backing both the server and
central channels) before any broadcast/HTTP response. A schema↔projection drift
now fails **loudly on the server** — reported → crash task, send skipped /
`sub-error` returned — instead of silently emptying the surface. See
`research/2026-06-08-global-mandatory-resource-schema-server-validation.md`.
**The originally-reported bug is fixed at the source.**

**This plan covers the remaining swallow point (2)** — the client side, which
the server work explicitly left untouched ("No client-side change"). It is
defense-in-depth: with server validation a client should never *receive* an
invalid payload, but a swallowed exception in the WS message handler is still a
"fail loudly" violation, and it's the last gap that could re-create the silent-empty
behavior under client/server schema **version skew** during a rolling deploy, or
a client-only bug.

## Problem

In `plugins/primitives/plugins/live-state/web/notifications-client.ts`,
`openChannel()`'s `ws.onmessage` (`:187-194`) wraps only `JSON.parse` in
try/catch, then calls `handleServerMessage` **unguarded**. A `ZodError` from
`schema.parse(value)` in `applyUpdate` (`:259`) / `applyDelta` is thrown into the
unprotected event callback and silently swallowed: the TanStack cache keeps its
`initialData`, and `useResource` returns `{ data, error: null }` — no error
state, no report. (The existing `sub-error` branch at `:222-225` only
`console.error`s; the applyUpdate/applyDelta throw path isn't even logged.)

## The change

File: `plugins/primitives/plugins/live-state/web/notifications-client.ts`

Wrap the `handleServerMessage` call in `onmessage` so a handler error fails
loudly instead of dying in the event callback:

```ts
channel.ws.onmessage = (ev) => {
  let msg: ServerMsg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  try {
    this.handleServerMessage(channel, msg);
  } catch (err) {
    // A schema.parse failure would otherwise silently leave the cache at its
    // empty default. Re-throw asynchronously so the global browser crash
    // reporter observes it as an uncaught error — without importing the crashes
    // plugin (live-state ← crashes would be an import cycle) and without
    // breaking the WS loop for subsequent messages.
    queueMicrotask(() => { throw err; });
  }
};
```

- `live-state` must **not** import `@plugins/crashes/web` (crashes depends on
  live-state for its own resource → cycle, blocked by `check plugin-boundaries`).
  `queueMicrotask(throw)` converts a swallowed-in-callback error into a genuine
  uncaught error that the crashes plugin's global `window` error listener
  reports. **Verify** that listener fires for an async re-throw; if a generic
  client-error-report primitive exists *below* crashes in the DAG, prefer it.

### Docs

`plugins/primitives/plugins/live-state/CLAUDE.md` "Resource schemas" section
(already describes the two-parse model on main) — add one line noting the client
parse now reports loudly on failure rather than swallowing.

## Critical files

- `plugins/primitives/plugins/live-state/web/notifications-client.ts` — de-swallow
  the `onmessage` handler.
- `plugins/primitives/plugins/live-state/CLAUDE.md` — one-line doc note.

## Verification

1. `./equin build` + `./equin check` (incl. `plugin-boundaries` — no
   new cross-plugin import).
2. **Happy path:** open `http://<worktree>.localhost:9000`, confirm bell +
   tasks/attempts lists still render (no regression in the message loop).
3. **Fail-loud:** simulate a client parse failure (e.g. temporarily register a
   stricter schema for one key, or feed a malformed `update` in a unit-level test
   of the `onmessage` wrapper) and confirm it surfaces as a reported uncaught
   browser error rather than a silently empty surface.
