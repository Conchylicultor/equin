# Sidequest ops queue behind the main track

**Ask.** A sidequest's push, check, test, build… must always run after the main
track's, and never block a main-track op from running.

## Where ops queue

Every heavy op takes a host-wide flock slot (`packages/host-semaphore`, pools
declared in `infra/host/host-admission`): `cpu` for build / check / test, `e2e`
for e2e scripts, `push` (size 1) for the push mutex. The `cpu` pool is laned
(interactive = main checkout + push, background = agent worktrees), but within
a lane — and across lanes for the moment a slot frees — nothing orders waiters:
whichever fan-out child the kernel wakes first wins. A sidequest push queued
first takes the mutex before a main-track push queued a second later.

## Design

**A priority, orthogonal to the lane.** The lane says which slots; the new
`Priority = "normal" | "low"` says who goes first.

**Mechanism: a per-pool demand lock** (`<pool>/demand.lock`).

- A `normal` acquire on the slow path holds it SHARED while it waits.
- A `low` acquire asks "is anyone waiting?" with a non-blocking EXCLUSIVE try;
  if so it waits for the exclusive lock in one `flock-wait` child (the kernel
  grants it when the last normal waiter stops waiting — no polling). After
  winning a slot it re-asks; a normal waiter that appeared meanwhile gets the
  slot handed back.

Measured on macOS: a new `LOCK_SH` is granted while a `LOCK_EX` is pending, and
the `LOCK_EX` waits until every shared holder leaves — so normal waiters never
queue behind a low one's gate, and low starves exactly while normal demand
persists. `packages/flock` gained `flockTryShared` and `waitForFlock({ shared })`.

Not pre-emption: a low holder keeps its slot until it releases (killing a
running build is not on the table). The guarantee is that a low op never takes
a slot a main-track op is queued for.

**Where the priority comes from.** `tasks/task-track` gained a `cli/` barrel,
`checkoutTrack(worktreeName)`: the track of the task whose attempt the checkout
is, read from the MAIN database (the worktree fork would be stale after a track
switch), table/column names pinned to the drizzle tables by a test.
op-runtime's `opPriority` maps sidequest → `low`, everything else → `normal`; an
unreachable database is printed and admits `normal` (priority orders a queue,
it bounds nothing).

**Where it applies.** `withHostGrant` / `withE2eGrant` take a REQUIRED
`priority` (tsc makes every acquirer decide). Low at: direct ops (check / test /
e2e — only when actually acquiring, not nested or joining a flight), build's
heavy-section grant, push's mutex. Push's grant *inside* the mutex stays
`normal`: every queued push waits out the holder, so a holder yielding CPU would
only stretch main-track pushes' wait.

## Not covered

- `type-check-worker` and the other inner pools are acquired by children under
  an already-held grant; they inherit no priority (a low op that got its grant
  is running, and inner waits are short-held).
- Duress valve holds are unchanged.
