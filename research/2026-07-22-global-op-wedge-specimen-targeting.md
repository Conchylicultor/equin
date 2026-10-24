# Op-wedge watchdog: target the true specimen — tree-aware verdict, probe, and reap

## Context

The capture-then-reap watchdog (af8f0c4bb, design:
[`2026-07-22-global-op-wedge-capture-then-reap.md`](./2026-07-22-global-op-wedge-capture-then-reap.md))
worked in the field on its first day — but the 01:51Z 2026-07-22 incident
(worktree `att-1784628905-m0gj`) exposed that its whole pipeline is keyed on the
**op-marker pid**, while the actual wedge can be a **marker-less descendant**:

- `./equin push` (marker pid, idle, holding the push mutex) spawned
  `check --scope tree`, which re-exec'd pre-armed under `bun --inspect`. That
  inner check worker was the wedge — 99% CPU in the known native microtask
  storm (oven-sh/bun#27766) — and it had **no marker**: `check.ts` deliberately
  skips marker+profiler when it inherits a host grant from push
  (`check.ts:153-196`, gate `inheritedGrant() === undefined`; push's spawn env
  carries `SINGULARITY_HOST_GRANT` via `grant.env()`, passed through the
  inspector re-exec). That design is sound (the push marker covers status) and
  is **kept** — the fix goes in the watchdog.

Three concrete failures, all observed in the filed report
(`"cpu idle, 2 live children — reaped (exited-sigterm)"`):

1. **Verdict "idle"** — the CPU delta samples only the marker pid
   (`capture.ts:352,371` `readCpuTime(req.pid)`), so an idle parent with a
   burning grandchild reads as idle.
2. **Probe pointed at the wrong inspector** — `probeWedgeJs` uses only the
   marker's `inspect` URL, so the JS interrogation profiled the idle push
   worker and learned nothing about the wedge producer (the whole point of the
   probe, per
   [`2026-07-22-global-cli-op-wedge-named-function.md`](./2026-07-22-global-cli-op-wedge-named-function.md)).
3. **Reap orphaned the burner** — `reapWedge` signals only the marker pid
   (`reap.ts:21-22` even documents "culprits have no children", now falsified);
   the burning grandchild survived at 99% CPU reparented to pid 1 and needed a
   manual kill.

A fourth, smaller hole lives in the CLI: the orphan-guard cascade
(`61b5fcfec`, already on main) has the wrapper `child.kill("SIGTERM")` then
`process.exit(140)` immediately — no SIGKILL escalation — so a SIGTERM-ignoring
wedged worker can outlive the whole cascade.

Everything needed to fix 1-3 is already *collected* and then dropped: the
capture's single whole-table `ps` read includes every descendant at any depth
with full argv (which contains a descendant's own `--inspect=<url>`) and even
`%cpu` — `capture.ts:402-408` just discards it.

**Prerequisite: rebase this worktree onto main first** — the branch predates
`61b5fcfec` (`orphan-guard.ts` does not exist here yet; Fix D edits its call
site).

## Design

One principle: **the watchdog targets the wedge, not the marker.** The marker
is the entry point; the *specimen* (the process to verdict/probe/reap) is found
by evidence — a per-pid CPU delta over the marker + all descendants. This
covers any future marker-less wedged descendant, not just push-nested checks.

No config changes: tree-reap replaces single-reap under the existing `reap`
toggle; specimen selection reuses the existing `cpuIntervalMs` window. Report
identity (fingerprint + dedupe `Set`) stays keyed on the **marker** pid — one
wedged op = one report; the specimen rides the payload.

### A. Specimen selection — `server/internal/capture.ts`

1. **`parseInspectFlag(command: string): string | null`** (new, exported,
   watchdog-local): `/--inspect=(\S+)/` over a ps `command` string. Bare
   `--inspect` (no URL) → null. Deliberately not shared with
   `worktree-op.ts:111` (which reads its *own* execArgv; here we parse another
   process's argv — different concern, one-line regex, not worth a cross-plugin
   edge).
2. **Replace the two single-pid `readCpuTime(req.pid)` reads with two
   whole-table reads** `readCpuTable()` → `ps -axo pid=,time=` parsed via the
   existing `parseCpuTimeMs` into `Map<pid, cpuMs>` (+ `atMs`). Same spawn
   count as today, coherent per-instant snapshot of every candidate (the
   descendant set isn't known until the tree read). Keep the measured-wall-gap
   discipline (sample doubles as the gap; top up to `cpuIntervalMs`).
3. **Per-pid ratio + specimen rule.** After the tree read:
   `ratioOf(pid) = (cpu2[pid] - cpu1[pid]) / wallMs` (null when either table
   errored, `wallMs <= 0`, or the pid is missing from a table — spawned/died
   mid-window). Candidates = marker + all descendants.
   - Any candidate with ratio > 0.5 → verdict **spinning**, specimen = the
     max-ratio spinning candidate.
   - Else → specimen = marker; verdict **idle** when the marker ratio is
     computable, else **unknown**.
   The top-level `cpu {deltaMs, wallMs, ratio, verdict}` now describes the
   **specimen** (identical to today when specimen == marker).
4. **Keep per-child CPU** in the public type/schema:
   `WedgeChild` gains `cpuPct: string` (ps lifetime average, context only — the
   module header's "misread single %CPU" warning stays) and
   `cpuRatio: number | null` (the verdict-grade sampled delta).
5. **New `WedgeCapture.specimen`**:
   `{ pid, command, cpuRatio, inspect: string | null }` — `inspect` via
   `parseInspectFlag(command)`. On ps-tree failure: specimen = marker,
   `command = "(ps-tree unavailable)"`, `inspect = null`.
6. Dump text: header gains `specimen=pid <p> ratio=<r> (marker|descendant)`;
   the tree lines gain `Δratio=<r|n/a>`.

### B. Probe the specimen — `server/internal/monitor-job.ts`

`probeWedgeJs` / `js-interrogate.ts` / `inspector-rpc.ts` need **no logic
change** (they take any ws URL + pid). The monitor computes the target:

```ts
const specimenPid = capture?.specimen.pid ?? info.pid;
const specimenInspect = capture
  ? (capture.specimen.pid === info.pid ? info.inspect : capture.specimen.inspect)
  : info.inspect;
```

and passes `{ pid: specimenPid, inspect: specimenInspect }` to `probeWedgeJs` —
so `armed` now means "the **specimen** has an inspector URL", and the probe's
paired second `lsof` also lands on the specimen. Update the `JsProbeRequest.inspect`
doc comment in `probe.ts` accordingly.

### C. Reap the tree — `server/internal/reap.ts` + monitor

Keep `reapWedge(pid)` byte-for-byte as the single-pid SIGTERM→5s→SIGKILL→2s
escalation (rename internal use to `reapOne`; existing tests keep passing). Add:

```ts
export type PidReapOutcome = ReapOutcome | "identity-mismatch" | "vanished";
export interface PidReapResult { pid: number; role: "marker" | "descendant";
  outcome: PidReapOutcome; failures: Array<{ step: string; error: string }> }
export type ReapRollup = "all-reaped" | "some-survived" | "disabled";
export interface TreeReapResult { outcomes: PidReapResult[]; rollup: ReapRollup;
  failures: Array<{ step: string; error: string }> }
export async function reapTree(marker: { pid: number }, descendants: WedgeChild[]): Promise<TreeReapResult>
```

- **Order: descendants deepest-first (reverse of the BFS nearest-first
  `children` list), marker last.** Children-first is deterministic (no race
  with the orphan-guard cascade for the same pids); the parent dies last so it
  can't observe/react to a half-killed subtree.
- **Pid-reuse safety:** one `ps -axo pid=,ppid=,command=` re-read at reap
  start. A descendant is signalled only if its live row still matches the
  captured `{ppid, command}` exactly; mismatch → `"identity-mismatch"`, absent
  → `"vanished"` — never signal an unconfirmed pid. If the re-read itself
  fails: push a loud `{step: "ps-reverify"}` failure and skip all
  *descendants*.
- **The marker is reaped regardless of the re-read** (its provenance is the
  marker file + this tick's liveness check via `readWedgedOps`) — the fleet
  must unblock even when ps is unavailable.
- Rollup: `some-survived` if any outcome ∈ {survived, identity-mismatch}, else
  `all-reaped`. (`disabled` is minted by the monitor when `cfg.reap` is off.)

Monitor wiring: `cfg.reap ? await reapTree({pid: info.pid}, capture?.children ?? [])
: { outcomes: [], rollup: "disabled", failures: [] }` (capture disabled ⇒
marker-only reap, documented). The one-line report `detail` gains
` — specimen pid <p>` when specimen ≠ marker, and the reap suffix becomes
`reaped (<rollup>)`.

Rewrite `reap.ts`'s header (drop "culprits have no children") and the plugin
`CLAUDE.md` Reap + JS-interrogation sections to the tree-reap / specimen model.

### D. Orphan-guard SIGKILL escalation — `plugins/framework/plugins/cli/bin/inspect.ts`

In the wrapper's orphan path (post-rebase call site from `61b5fcfec`), replace
kill-and-exit with a bounded escalation, dependency-free (this file runs before
anything loads):

```ts
let orphanHandled = false;
installOrphanGuard(() => {
  if (orphanHandled) return;          // 2s poll must not re-enter mid-grace
  orphanHandled = true;
  child.kill("SIGTERM");
  void (async () => {
    const r = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
    if (r === "timeout") child.kill("SIGKILL");   // #27766: the storm may ignore SIGTERM
    process.exit(ORPHAN_EXIT_CODE);
  })();
});
```

### Schema — `core/kinds.ts` (additive/backward-compatible)

- `capture.children[]`: add `cpuPct: z.string().optional()`,
  `cpuRatio: z.number().nullable().optional()`.
- `capture.specimen`: `z.object({ pid, command, cpuRatio, inspect: z.string().nullable() }).optional()`.
- `reap`: becomes `z.union([<new tree shape: {outcomes[], rollup, failures}>,
  <legacy: {outcome, failures}>]).optional()` so pre-existing rows still parse
  in `renderTask`; legacy arm commented for deletion once old rows age out.

### Renderers

- `server/internal/op-wedge-kind.ts` `renderTask`:
  - Reword the CPU-verdict paragraph: the verdict is a delta over the marker
    **and every descendant**; `idle` means *no pid in the tree* crossed the
    threshold (the current "idle = parked in a blocking syscall" reading was
    exactly wrong for this incident).
  - Add a **Specimen** line (`pid`, `command`, ratio) with a bold callout when
    specimen ≠ marker ("the burn is a marker-less descendant; the JS
    interrogation and reap follow the specimen").
  - Child-tree table gains `%CPU(life)` and `ΔRATIO` columns (mark ratio > 0.5).
  - `renderReap`: branch on shape — legacy switch unchanged; tree shape renders
    a rollup line + per-pid `PID | role | outcome` table.
- `web/components/op-wedge-summary.tsx`: reap chip handles both shapes
  (`failed` = `some-survived` / legacy `survived`); add a muted `specimen <pid>`
  span when specimen ≠ marker.

## Files touched

- `plugins/debug/plugins/op-wedge-watchdog/server/internal/capture.ts` (A)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/monitor-job.ts` (B, C wiring)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/probe.ts` (doc comment only)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/reap.ts` (C)
- `plugins/debug/plugins/op-wedge-watchdog/core/kinds.ts` (schema)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/op-wedge-kind.ts` (renderer)
- `plugins/debug/plugins/op-wedge-watchdog/web/components/op-wedge-summary.tsx` (renderer)
- `plugins/debug/plugins/op-wedge-watchdog/CLAUDE.md` (Reap + interrogation sections)
- `plugins/framework/plugins/cli/bin/inspect.ts` (D, post-rebase)
- Tests: `capture.test.ts`, `reap.test.ts` (extend; see below)

## Tests (bun:test, co-located; run `bun test plugins/debug/plugins/op-wedge-watchdog`)

- `capture.test.ts`:
  - `parseInspectFlag` unit: with URL / bare `--inspect` / absent.
  - **Idle parent + spinning child** (`sh -c 'sleep 0.1; (while :; do :; done) & wait'`):
    verdict `spinning`, `specimen.pid !== proc.pid`, specimen ratio > 0.5,
    marker's own ratio low, children carry numeric `cpuRatio` + string `cpuPct`.
  - Existing idle / spinning-no-children tests: additionally assert
    `specimen.pid === proc.pid` (regression: today's shape unchanged).
- `reap.test.ts` (existing `reapWedge` cases unchanged):
  - `reapTree` kills parent+child tree → both exited, `rollup: all-reaped`.
  - Identity mismatch (live pid, bogus captured `command`) → `identity-mismatch`,
    sleeper **still alive**, rollup `some-survived`.
  - Vanished descendant (already-exited pid) → `vanished`, no signal, no throw.
- Fix D: covered by the e2e recipe (deterministic reparenting is impractical in
  a unit test).

## Verification (end-to-end)

1. Rebase onto main, `./equin build`.
2. **Regression (specimen == marker):** the existing synthetic recipe (fake
   over-budget `check.json` marker → armed spinning dummy). Expect: verdict
   spinning, `specimen.pid == marker`, probe names the dummy's hot fn, reaped,
   `all-reaped`.
3. **New — the incident shape:** idle armed parent
   (`bun --inspect=localhost:<P>/tok -e 'setInterval(()=>{},1000)'`) spawning a
   spinning armed child (`bun --inspect=localhost:<C>/tok` busy-yielding loop);
   fake over-budget `push.json` naming the **parent** pid + parent inspect URL.
   Trigger the monitor (Debug → Queue). Assert: verdict `spinning`;
   `specimen.pid == child` with `specimen.inspect == localhost:<C>/tok` (parsed
   from argv, not the marker URL); `jsProbe.topStacks` names the **child's**
   hot function; reap outcomes cover parent (marker) *and* child (descendant),
   both exited, `all-reaped`; both pids gone; a `./equin push` from
   another worktree proceeds.
4. **Fix D:** orphan a `./equin check` whose worker traps/ignores
   SIGTERM; wrapper must SIGKILL it within ~5s and exit 140.
5. **Field:** next real wedge reports a named hot stack for the *burning* pid,
   a specimen callout when marker-less, per-pid reap table, fleet frees ~2 min
   after budget trip.

## Edge cases (decided)

- specimen == marker (spinning or idle) → byte-for-byte today's behavior.
- Multiple spinning descendants → max ratio wins; others carry their own
  `cpuRatio` in the payload.
- Descendant dies between capture and reap → `vanished`, no signal.
- Pid reused between capture and reap → `identity-mismatch`, never signalled.
- ps tree read fails at capture → specimen = marker, `inspect` null (monitor
  falls back to marker-file inspect), descendants empty.
- ps re-read fails at reap → descendants skipped loudly, marker still reaped.
