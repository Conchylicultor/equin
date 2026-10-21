# Duress admission one-at-a-time, on FIFO host queues (v2)

v1: [2026-10-20-cli-duress-admission-one-at-a-time.md](./2026-10-20-cli-duress-admission-one-at-a-time.md)
(the duress gate). v2 adds first-come-first-served ordering to every host queue
and builds the gate on the same primitive.

## Context

- Every host-wide wait (build/check/test/e2e CPU grant, push mutex, db-fork, …)
  goes through `packages/host-semaphore`. Its order is arbitrary: a fresh caller
  barges past waiters on the fast path, and the turnstile is a plain flock (the
  kernel wakes an arbitrary waiter). The user expected FIFO.
- The duress valve holds every agent build with no progress guarantee and fakes
  one with a 30-min fail-open that a requeue resets (a build starved 1h11).

Outcome: within a class of waiter, strict arrival order; under duress, agent
builds run one at a time, in arrival order; no timeouts anywhere.

## Part 1 — `packages/ticket-line`: a crash-safe cross-process FIFO line

`createTicketLine(dir)` → `{ join(signal?): Promise<Ticket>, isEmpty() }`;
`Ticket = { leave(): void }`. `join` resolves when the caller is at the head.

- **Ticket**: a file `t-<hrtime ns, 20 digits>-<pid>.lock`, created under a temp
  name, flocked exclusive in-process, then renamed into place — so a visible
  ticket is always locked by a live owner. Names are never reused. hrtime is
  CLOCK_MONOTONIC, shared by every process on the machine.
- **Wait**: the predecessor is the greatest live ticket below mine. `flockTry` it
  (free = its owner left or died: reap the file, rescan); else one `waitForFlock`
  child on it. Granted → reap, rescan. No predecessor → head.
- **Leave**: unlink then close (the successor's child wakes on the close).
  Process death closes the fd → the successor wakes and reaps the file.
- **isEmpty**: any `t-*` file that `flockTry` cannot take. A free one is reaped.
- Cancellation: `signal` aborts the wait (kills the child), removes the ticket.
- Accepted: two callers arriving within the same microsecond (between reading the
  clock and the rename) can both see no predecessor; ordering between them is
  arbitrary and the semaphore's bound is unaffected.
- Cost: one `flock-wait` child per queued waiter (today: one turnstile child per
  waiter) — no change.

## Part 2 — `host-semaphore`: one line per class replaces the turnstile

Class = (lane, priority): `line-<lane>-<priority>/` in the pool's slot dir.

- **Fast path only when the caller's line is empty** — no barging past your own
  class. Different classes keep today's rules (lanes partition slots; `low`
  yields to `normal` via `demand.lock`; heads of different classes race for a
  shared slot, as today).
- **Slow path**: `normal` holds `demand.lock` shared (unchanged) → `join` the
  class line → as head: sweep, else fan out (unchanged) → leave the line →
  sweep extras. The turnstile file is deleted.
- **`low`** keeps its ticket across its yield loop (wait for no demand → take →
  hand back if demand appeared), so yielding never costs its place in line.
- `depth()`, hooks, cancellation, size identity: unchanged.

## Part 3 — the duress gate (v1 design, FIFO)

Gate dir `locks/agent-build-gate/`: `gate.lock` (readers/writer) + a ticket line
for exclusive waiters.

```
admit(gated):
  loop:
    duress → join the line (aborted if the latch clears) → as head: flockTry EX,
             else race waitForFlock(EX) vs clear → leave line.
             EX → return exclusive (never re-checked). Clear → loop.
    calm   → flockTry SH, else waitForFlock(SH) (an EX build runs: wait for it);
             re-check duress: fresh → release, loop; else return shared.
build: admit → withHostGrant → if shared && duress: REQUEUE (release grant +
       gate) → loop. Ungated: no gate.
```

Deleted: `MAX_VALVE_HOLD_MS`, `HoldOutcome`'s `fail-open`, `shouldRequeue`,
`holdThroughValve`. Kept: `valveGates`, `checkValveGuard`. The op-log keeps the
`fail-open` / `requeue` vocabulary for recorded ops.

Gate-first then grant: a gate waiter never holds idle CPU slots, and the only
wait a gate holder performs is on the grant, whose holders always finish →
deadlock-free. Per target of a multi-target build (never hold the gate across
targets).

## Files

- new `plugins/packages/plugins/ticket-line/` (core barrel, tests with real
  child processes, exempt `boundaries/no-platform-api` debt like single-flight).
- `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` +
  tests + CLAUDE.md.
- `plugins/framework/plugins/cli/plugins/op-runtime/`: `data-dirs/index.ts` (new),
  `cli/admission-valve.ts` (+ test), barrel, CLAUDE.md.
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`,
  `build/cli/run.ts`.
- prose: op-log / op-gantt CLAUDE.md where they describe fail-open / order.

## Verification

- `./singularity test plugins/packages/plugins/ticket-line plugins/packages/plugins/host-semaphore plugins/framework/plugins/cli/plugins/op-runtime`
  — ticket-line: order of N children, a SIGKILLed middle waiter, abort, reap of a
  dead ticket; host-semaphore: a fresh caller does not barge past a queued one of
  its class, waiters granted in arrival order, existing 31 tests green; gate:
  duress → exclusive waits for a shared holder, clear mid-wait → shared.
- `./singularity build`.
