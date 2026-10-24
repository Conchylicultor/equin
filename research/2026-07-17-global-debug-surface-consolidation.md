# Debug-surface consolidation: front door, ingestion gaps, and reader dedup

## Context

During the 2026-07-17 compressor-thrash incident, the investigating agent misdiagnosed the
severity ("degraded" instead of "pages take minutes") because it sampled raw jsonl surfaces and
stopped at the first sufficient cause — while the minute-scale `deliver:*` spans sat in the
runtime profiler and an **11.5-minute never-ready boot of main** (13:44:54 start, no `ready`,
replaced 13:56:29) sat in `boot.jsonl`, consumed by nothing. Post-mortem in
`research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md` §2026-07-17.

Root problem, per the user's framing: not "too many surfaces" but **no canonical top**. The
synthesis layers already exist — **Reports** (the alert funnel) and the **Timeline** (the
cross-worktree wall-clock Gantt, already a tab of Debug → Slow Events) — but they are not the
enforced entry point, agents can't practically consume the timeline, and two failure signals
never reach the funnel at all. This plan consolidates the *existing* surfaces instead of adding
new ones: same producer, same event model, same reports engine.

Four workstreams, independently landable. Designed by four parallel Opus plan agents on top of a
three-agent exploration pass; reconciled here.

---

## WS1 — `get_timeline` MCP tool: agent access to the existing timeline producer

**No new endpoint, table, or data model.** One MCP tool inside the timeline plugin, calling the
existing `produceTimeline` **in-process**, rendering frames as compact local-time text.

Named deviation from the `get_queue_health`/`get_runtime_profile` gateway-fetch precedent: that
precedent exists to reach a *different* backend's live in-memory state; the timeline's answer is
**backend-independent by construction** (fork-DB fan-out via `listLiveForkDatabases` + shared
host filesystem reads), so there is no other backend to reach — and `readNdjson` is
web-only anyway. No `worktree` arg for the same reason.

Files (all under `plugins/debug/plugins/timeline/`):
- `server/internal/handle-timeline.ts` — export the currently-private `produceTimeline` (handler unchanged).
- **new** `server/internal/collect.ts` — `collectTimeline(fromMs, toMs)`: array-push emit wrapped in the same `runInBackgroundLane(() => runWithoutProfiling(...))` guard.
- **new** `server/internal/format.ts` — `formatLocal(ms)` + tz-name + `formatDurationMs`. Lives in `server/internal/`, **not `core/`**: `core/model.ts` mandates wall-clock epoch ms as the only wire clock; local time is a presentation concern of this text tool only.
- **new** `server/internal/render.ts` — pure `renderTimeline(frames, opts): string`; `bun:test`-able.
- **new** `server/internal/mcp-tool.ts` — `Mcp.tool({ name: "get_timeline", ... })`.
- `server/index.ts` — `register: [timelineTool]`.
- **new tests** `render.test.ts`, `format.test.ts` (co-located bun:test).
- `CLAUDE.md` — "Agent access" section: MCP tool primary, raw `curl 'http://<wt>.localhost:9000/api/debug/timeline?fromMs=…&toMs=…'` fallback.

Input schema: `lookbackMinutes` (default 30, max 1440), `endIso` (historical windows; reject NaN
loudly), `minSeverity` (default info), `sources` (subset of `TIMELINE_SOURCES`), `maxEvents`
(default 200, max 1000). Epoch ms never exposed to the agent.

Output contract (agent-optimized, all times local w/ tz in header):
1. **DURESS block first** — one line per episode, never capped ("signal is thinned inside these").
2. **HOST PRESSURE peak** (reuses `shared/pressure.ts` score) + **BACKEND HEALTH peaks** (p99/phys per lane; sub-warning lanes collapsed to a count) — the health series is summarized, never dumped.
3. **EVENTS** — severity-first retention (errors/warnings can't be dropped for info), then re-sorted by wall clock for cross-worktree cause→effect reading; one line per event with inline worktree + `trace=` id.
4. **Explicit drop accounting** per source+severity (repo rule: no silent caps) and a **CHUNK ERRORS** block for `ok:false` cells — missing data must never read as calm.

## WS2 — Debug skill as a decision tree; perfs method step-1 fix

Markdown-only. Full replacement text drafted verbatim in the plan agent's report (kept with this
doc's review materials); structure:

- **`.claude/skills/debug/SKILL.md`** rewritten: mandatory **STEP 0** (Reports = "am I being
  alerted?" + Timeline via `get_timeline` / Slow Events → Timeline tab = "what happened when?"),
  a "do not stop at the first sufficient cause" callout, then 7 symptom branches (slow/freeze,
  stale UI, crash, high memory, render churn, slow first paint, queue stuck), a cross-cutting
  footer (logs, query_db, claude-cli-calls, Playwright), and a closing **front-door invariant**
  ("every durable failure signal lands in Reports or Timeline — if you found one by hand, file
  it"). All hard-won caveats preserved but moved into their branches (rss vs phys_footprint,
  IOAccelerator, recentMax vs max, work-vs-wait, manualChunks union). Length parity by rendered
  chars (±5%). **Fixes two already-dead links** (old `plugins/crashes/…` paths → the renamed
  `plugins/reports/…`).
- **`research/perfs/CLAUDE.md` Method step 1** replaced: front door first (Reports + Timeline
  window around the symptom), THEN `benchmark_boot` + `get_runtime_profile` for quantification.
- **`.claude/skills/perfs-investigation/SKILL.md`**: one sentence + link under Phase 1 pointing
  to the same front door (methodology stays pure).
- Deliberate convention break flagged: `debug` alone becomes a decision tree; `css`/`theme` stay
  flat maps (they aren't used under incident pressure).
- If WS1 lands in the same push, drop the `> Dependency:` fallback note; otherwise keep it.

Non-debug panes scoped out of the skill: Backup, Recovery, Layout Lab, Events Test, Zero Test,
Broadcasts, Memory-browser, Read-set, Live-State-Emit, Worktree-Cleanup.

## WS3 — Ingestion gaps: wedged-boot watchdog, duress-episode report, enforcement check

The timeline half of both gaps already exists (never-ready boots render as bars; duress episodes
as bands). This adds the missing **report/bell** half. Both new signals are observed on main, so
the report row's `worktree` is always `main` → **the subject must live in the fingerprint**.

### (a) `boot-wedge` — new sub-plugin `plugins/debug/plugins/boot-watchdog/` (mirrors boot-budget's layout)

- Job `debug.boot-watchdog-monitor`: cron `* * * * *`, **no `perWorktree`** (main-only —
  structurally required: a perWorktree job can't observe its own wedged boot; jobs dequeue only
  after boot succeeds), `dedup:"singleton"`. Each tick: sweep every worktree's boot channel via
  `readBootEvents(wt, lookbackMs)` (exactly how the timeline already reads them), pick unpaired
  `start`s older than `bootReadyBudgetMs` (default 120 s):
  - **superseded** (the 13:44 case) → file once (module-Set guard keyed `wt:processStartedAt`,
    boot-budget's pattern) — the outage is on record post-hoc.
  - **open** → file only if the gateway fleet list (`GET /gateway/worktrees`, 2 s timeout,
    mirrors sentinel's `readFleetFromGateway`) shows the worktree live (wedged-now vs torn-down);
    re-files each tick so `count` ≈ minutes wedged and the bell re-arms. Gateway unreadable →
    skip open eval this tick.
- Kind: `fingerprint: boot-wedge:<worktree>` (crash-loop collapses to one row, count=attempts),
  variant `error`, cooldown 15 min, source `"server-boot-watchdog"`. Config:
  enabled / bootReadyBudgetMs / lookbackMs. KindView one-liner in `web/`.
- Impl-time verification item: the gateway's live-state vocabulary for mid-boot backends
  (`starting` vs `running`) — safe default: presence in fleet list = live.

### (b) `duress-episode` — lives in sentinel (stall-monitor precedent: detector owns detection, direct `void recordReport`)

- Filed **once per episode, on clear**, from `onset.ts:handleClearFrame` (main side, already in
  the background lane). Open episodes are bounded by `maxEpisodeHoldMs` (~30 min force-clear);
  the trip instant is already covered by the `cluster-onset` critical trace + timeline band.
- Small protocol add: worker's Episode carries `elevated`; the clear frame carries
  `{reason, elevated, episodeSetAt, wall, forced}` through `worker/protocol.ts` → `sampler.ts` →
  `onset.ts`.
- `fingerprint: duress-episode:<sorted elevated signals>` — per **cause-signature**, not per
  episode: a 10-episode storm collapses to a few rows with count=episodes (the trustworthy
  front-door shape; per-episode rows rejected as spam). Variant `warning` (notes `forced`),
  cooldown 30 min, source `"server-duress-monitor"`.
- **`duressExempt: true` — argued**: this report IS the durable record of the condition that
  drives shedding; without exemption it can be lost to a re-trip racing the async record, or to
  buffer overflow at peak. Meets the same bar as the only existing exempt kind (`duress-shed`):
  loss would corrupt the signal itself.
- Named follow-ups (non-blocking): mid-episode "still elevated after N min" escalation; a sweep
  for lapse-terminated episodes (trip with no clear because main died — separately visible via
  boot-wedge); per-episode peak metrics.

### (c) `durable-signals-accounted` — new built-in check (neutral owner: `tooling/checks`, mirrors `host-pools-declared`)

- Local allowlist `accounting.ts`: `Record<channelId, {consumer: "report"|"timeline"|"rendering-only"|"internal", note, reportKind?, timelineSource?}>`.
  Local to the check on purpose — a low-level channel primitive must never name reports/timeline
  (dependency inversion); a `definePersistedChannel` registry refactor was rejected as
  disproportionate (~18 channels to migrate for a guardrail).
- Check: grep `Log.channel(<id>, {persist:true})` call sites (resolve the ~2 const-named ids;
  unresolvable → loud failure), then enforce (1) every channel classified, (2) `report` entries
  have a live `ReportKind({kind})`, `timeline` entries ∈ `TIMELINE_SOURCES`, (3) no stale
  allowlist keys. It does not force every channel to be a report (health is continuous) — it
  forces every new durable channel to be a **conscious, reviewed classification**.
- Seed encodes this plan: `boot` → report(boot-wedge)+timeline(boot); `duress-episodes` →
  report(duress-episode)+timeline(duress); health channels → timeline; the rest classified
  rendering-only/internal with notes. Regressing (a)/(b) later fails the check.

Cross-cutting: add `"server-boot-watchdog"`, `"server-duress-monitor"` to
`SERVER_REPORT_SOURCES` in `plugins/reports/core/sources.ts` (typed requirement). No migrations.

## WS4 — Sampler/reader dedup (proportionality-first verdicts)

- **loadavg (health-monitor vs sentinel): NO code change.** A free syscall on the latch-critical
  worker thread must not become a 10 s-stale file read (trip-timing risk; isolation premise).
  Deliverable: "Host-metric ownership" notes in both CLAUDE.mds + cross-referencing comments at
  `host-sampler.ts` and `worker/sample.ts`. Compressor/vm_stat stays single-sourced (already is).
- **Timeline reusing `readHealthSeries`: NO** — wrong on window shape (one-sided vs two-sided),
  return shape, and cap. Served instead by:
- **`readChannelJson<T>(worktree, channel, tail, schema): T[]` on `log-channels`** — the one real
  duplication: the tolerant torn-tail parse loop (`readChannelEntries` → JSON.parse w/
  SyntaxError-skip → safeParse-drop) is copy-pasted across **5 readers** (health-monitor
  `parseSamples`, timeline `sources/health.ts`, boot-events `read-boot-events.ts`, sentinel
  `read-duress-episodes.ts`, slow-ops `read-markers.ts`). Add the ~15-line primitive to
  `log-channels/server/internal/persist.ts` (+ barrel export), fold the 5 readers (each keeps its
  own tail cap); note at the primitive that missing-channel collapses to `[]` (all 5 already do).
  Sentinel's bespoke single-line readers (`readHostCompressor`, `readBackendP99Rollup`) stay
  as-is. No lint rule yet (gate on recurrence).

---

## Ordering & interactions

1. **WS4's `readChannelJson` first** (or in the same change as WS3) — WS3's watchdog consumes
   `readBootEvents`/`readDuressEpisodes`, which get folded onto the primitive; landing the fold
   first avoids touching those readers twice.
2. **WS1 + WS3 next**, independently. WS3's check seed references WS1 nothing; WS3's kinds appear
   on the timeline's report lane for free.
3. **WS2 last** (or with WS1): the skill references `get_timeline`; drop its dependency note when
   WS1 has landed.

## Verification (end-to-end)

- `./equin build` + full `./equin check` after each workstream (registry, doc-sync,
  type-check, and — after WS3 — `durable-signals-accounted` itself).
- **WS1**: `bun test plugins/debug/plugins/timeline` (drop accounting, severity-then-wall-clock,
  duress-first, chunk-error surfacing, local-time); from an agent conversation call
  `get_timeline {lookbackMinutes: 120}` and diff against the Timeline tab for the same window
  (same producer ⇒ must match); `endIso` on a past incident window; confirm CHUNK ERRORS appears
  when a fork times out; curl fallback unchanged.
- **WS2**: link sweep (zero MISS; the two fixed crash links resolve); dry-run STEP 0 against the
  2026-07-17 incident — an agent following it literally cannot miss the deliver-span reports or
  the never-ready boot bar; rendered-length parity ±5%.
- **WS3**: synthetic wedged boot (append `start`@T + superseding `start`@T+6min to a throwaway
  worktree's boot.jsonl) → boot-wedge report + bell + timeline bar; open-wedge only while the
  gateway lists the worktree; sentinel worker driven trip→clear via the existing
  `latch-lapse.test.ts` harness → duress-episode report (one row per cause, count bumps per
  episode), re-trip during the async record to prove `duressExempt` persists; check
  negative-tested (stray persisted channel → fail with hint; report entry pointing at a
  nonexistent kind → coherence failure).
- **WS4**: behavior-preserving fold — Health pane, Timeline health heat/boot bars/duress bands,
  Slow Ops markers all render identically; `readChannelJson` unit test (torn line dropped,
  invalid dropped, missing → `[]`); sentinel trip behavior byte-for-byte unchanged.

## Explicitly out of scope (tracked elsewhere)

The incident's *remediation* altitudes — fleet memory admission, duress-gating main deploys /
blue-green deploy handoff, `corpus-index:ensure-fresh` rate investigation — are separate
workstreams tracked in `research/perfs/` (2026-07-17 recurrence section). This plan only fixes
how incidents are *seen*.
