# Health report: machine CPU/RAM breakdown + minimal Agent browser row

## Context

The health report's **Agent browser** row shows too much (host pid, code id,
uptime, per-role CPU/RAM sentence, raw conversation ids, per-tab lines). The
user also wants to know **where the machine's CPU and RAM go**: the user's
Chrome, agent ops (builds / checks / tests / e2e), the agent browser, and the
rest — shown *inside* the existing **Machine watcher** card, nothing removed
from it. Prototype: `proto-1792516777-e95kao`. Also ships the already-made
agent-browser idle close 30 → 10 min (`SESSION_IDLE_MS`).

## 1. Machine usage breakdown — new sub-plugin `debug/sentinel/plugins/machine-usage`

**core/** — `machineUsage = liveValue("sentinel.machine-usage", …)`:

```ts
MachineUsageBucket = z.enum(["chrome", "agent-ops", "agent-browser", "other"])
MachineUsage = { kind: "sampled", at, cores, totalMemBytes,
  buckets: { bucket, processes, cpuPercent /* ps %cpu sum, 100 = one core */, memBytes }[] }
| { kind: "unsupported", reason }   // non-macOS / no ps
```

Bucket labels + order as plain data in core (closed list).

**server/** — `machineUsageServed = serveValue(machineUsage, { source: "external",
changes: "notified", loader, whileSubscribed: notify-once })`: the exact
precedent of `agentBrowserUsageServed` (`browser/server/internal/host-client.ts:446`)
— one reading per opening of the row, no timer. Served on every backend (the
machine is the same from any of them).

Loader:
1. `ps -A -o pid=,ppid=,%cpu=,rss=,args=` via `spawnExpectOk` (format and
   ppid-tree walk from `browser/bin/host-usage.ts`).
2. Roots:
   - agent ops: `listActiveWorktreeOps()` (`@plugins/infra/plugins/worktree/server`) → marker pids (build, push, check, test, e2e; nested ops are inside a parent's tree).
   - agent browser: the host pid from the browser's status file — export `readAgentBrowserStatus` (or a narrow `agentBrowserHostPid()`) from the browser server barrel.
3. `attributeProcesses(procs, roots)` — pure, tested: subtree of the browser
   host → `agent-browser`; subtree of an op pid → `agent-ops`; args inside
   `/Google Chrome.app/` (main + helpers live in the bundle) → `chrome`; else
   `other`. Precedence in that order.
4. Memory per process = phys_footprint (what Activity Monitor shows; RSS
   over-counts Bun ~6×). Add a peer read to the memory probe
   (`server-core/core/memory-probe.ts` + `bin/phys-footprint.ts`):
   `peerProcMemory(pid): ProcMemory | { kind: "unreadable" } | null` — a
   failing `proc_pid_rusage` on a *foreign* pid (another user's, or exited
   since `ps`) is an answer, not a crash; the loader reads its own pid first
   through the throwing `procMemory()` so a broken binding still fails loudly.
   Unreadable → that process's ps RSS.
5. `cores = os.cpus().length`, `totalMemBytes = os.totalmem()`.

**web/** — `<MachineUsageBreakdown/>`: subscribes `useLive(machineUsage)`;
loading state via `primitives/loading`; renders the prototype's "Where it
goes": a CPU bar (share of all cores) and a RAM bar (share of total memory),
each segmented by bucket, then a small 3-column legend (name · CPU % of
machine · RAM GB). Bucket colours from existing chart tokens. Pure view model
`machineUsageView(usage)` (percent of machine, GB text, segment widths) with a
vitest test.

**Sentinel** — `RecordedDetail` (`sentinel/web/components/machine-watcher-detail.tsx:75`)
inserts a separator, "Where it goes" caption and `<MachineUsageBreakdown/>`
between the signal lines and the footer. Mounted only while expanded, so the
`ps` runs only when someone opens the card. Glance, summary, signals and
footer unchanged.

## 2. Minimal Agent browser row (`infra/mcp/browser/web`)

- **Summary** (`agent-browser-health.ts`): `N sessions` (+ `· N waiting for a
  browser slot` when > 0); idle → `Idle — exits in 3 min`; error/died/absent
  verdicts unchanged.
- **Detail** (`agent-browser-detail.tsx`) reduced to:
  - the sessions DataView with three fields: the session's **task title**
    (`useConversationById(conversationId)` from `@plugins/conversations/web`,
    `taskTitle || title || id`, a per-row component), **tabs** count, and
    **closes** (`6 min`, warning tone under 2 min);
  - one line for the latest host error when recent (`message · 7:01 PM`).
  - Removed: host line (pid / since / code / drives), usage line, per-tab lines.
- **`agent-browser.usage` removed end to end** (core value + schema, server
  serve, host `/usage` route, `bin/host-usage.ts`, web hook): its numbers now
  live in the Machine watcher's breakdown. Dropping a host route needs no
  `HOST_PROTOCOL` bump (an old host still answering it is harmless). Update
  the plugin's `CLAUDE.md` / description.
- Already done: `SESSION_IDLE_MS = 10 min` + its mentions.

## Files

- new `plugins/debug/plugins/sentinel/plugins/machine-usage/{core,server,web}/…`, `package.json`, `CLAUDE.md`
- `plugins/debug/plugins/sentinel/web/components/machine-watcher-detail.tsx`
- `plugins/framework/plugins/server-core/{core/memory-probe.ts,bin/phys-footprint.ts,bin/host-probes.ts}`
- `plugins/infra/plugins/mcp/plugins/browser/{web/**,core/internal/status.ts,server/**,bin/host.ts,bin/host-usage.ts (delete),CLAUDE.md}`

## Verification

- `./singularity test` on the new plugin (attribution, view model) and sentinel / browser web tests.
- `./singularity build` (codegen, checks), then `browser_*` on my build: open
  the health report, expand Machine watcher (breakdown renders, sums plausible
  vs Activity Monitor) and Agent browser (task titles, closes-in).
- Screenshot compare against the prototype; then `./singularity push`.
