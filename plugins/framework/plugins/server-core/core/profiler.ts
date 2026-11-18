import { heapMemory, ownCpuMs, physFootprintBytes } from "./memory-probe";
import { getBootMode } from "./boot-mode";
import { schemaRoleFor, type SchemaRole } from "./schema-role";

export type PhaseId =
  // Importing the plugin graph (`loadServerPlugins`): one `load:wave-<n>` span
  // per load wave, and a `load:<plugin>` / `load-core:<plugin>` span for each
  // barrel whose import took at least `LOAD_SPAN_FLOOR_MS`.
  | "load"
  | "register"
  | "awaitPgReady"
  | "runMigrations"
  | "routePopulation"
  | "socketBind"
  | "onReadyBlocking"
  | "onReady"
  | "onAllReady"
  // The desktop serving host's wait for the tabs' restart replay to settle
  // (`serve`, before the settled phase): one `replaySettle` span from the
  // ready barrier's arming to the replay's settle.
  | "replaySettle"
  // The serving host's settled phase (`runSettledPhase`), after the onAllReady
  // barrier: `settled` is the wrapping span — its presence marks a complete
  // boot profile — each plugin's hook an `onSettled:<id>` span, and each
  // drained warm-up (infra/warmup) a `warmup:<name>` span.
  | "settled"
  | "onSettled"
  | "warmup"
  // A named part of a boot hook (`BootHookContext.step`): a span under the
  // hook's own (`parent`), so a slow hook says which of its parts was slow.
  | "step";

export interface Span {
  id: string;
  phase: PhaseId;
  plugin?: string;
  label: string;
  startMs: number;
  durationMs: number;
  /** phys_footprint (MB) at span start — the real macOS footprint, not rss. */
  physFootprintStartMb?: number;
  /** phys_footprint (MB) at span end. */
  physFootprintEndMb?: number;
  /** The span this one is a part of (a `step`'s hook or outer step), by id. */
  parent?: string;
}

/**
 * A phase-boundary memory snapshot. Unlike per-span footprint deltas (which overlap
 * for plugins running under Promise.all in onReadyBlocking/onReady and are only
 * directional), these boundary checkpoints are the authoritative numbers.
 */
export interface MemoryCheckpoint {
  label: string;
  atMs: number;
  /** Real macOS phys_footprint (MB); falls back to rss off-darwin. */
  physFootprintMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  /**
   * CPU this process had used by then (user + system, ms) — the difference
   * between two checkpoints is the boot work's CPU between them, every
   * concurrent hook included (spans overlap on one loop, so per-span CPU has
   * no honest split). Absent on a host with no CPU reader.
   */
  cpuMs?: number;
}

const bootStart = performance.now();
const spans: Span[] = [];
const idCounts = new Map<string, number>();
const memoryCheckpoints: MemoryCheckpoint[] = [];
let timeToReadyMs: number | null = null;

/** bytes → MB, rounded to 1 decimal. */
function toMb(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

/**
 * Real macOS phys_footprint in bytes, falling back to rss off-darwin (where
 * proc_pid_rusage has no equivalent). The host is the user's Mac, so this is
 * effectively always the true footprint. `null` on a host that installed
 * neither probe (the browser worker).
 */
function footprintBytes(): number | null {
  return physFootprintBytes() ?? heapMemory()?.rss ?? null;
}

function footprintMb(): number | undefined {
  const bytes = footprintBytes();
  return bytes === null ? undefined : toMb(bytes);
}

/**
 * One line of the boot journal: the boot profile as it accrues, so a backend
 * killed before ready (the gateway's readiness deadline is a SIGKILL, which
 * runs no handler) still left where it was. `open` is written as a span
 * STARTS, for the spans that name what they hold (`members` — a load wave's
 * plugins), so the last open with no matching `span` is the step it died in.
 */
export type BootJournalEntry =
  | {
      e: "open";
      id: string;
      phase: PhaseId;
      label: string;
      startMs: number;
      members: readonly string[];
    }
  | {
      e: "span";
      span: Span;
      /** A load wave's slowest barrel imports (their own spans stay in memory). */
      slowest?: readonly { plugin: string; ms: number }[];
    }
  | { e: "checkpoint"; checkpoint: MemoryCheckpoint };

/**
 * A finished span is journaled when it took at least this long (every `load`
 * span is): the boot's slow steps, not its few hundred quick ones.
 */
const JOURNAL_SPAN_FLOOR_MS = 50;

/**
 * A plugin barrel's import is a span of its own when it took at least this
 * long — the wave's span covers the rest.
 */
export const LOAD_SPAN_FLOOR_MS = 100;

/**
 * The log channel a serving backend journals its boot to
 * (`<logs>/boot-journal.jsonl`), one `{ processStartedAt, entry }` line per
 * entry — `processStartedAt` the boot-events pairing key
 * (`Math.round(performance.timeOrigin)`).
 */
export const BOOT_JOURNAL_CHANNEL = "boot-journal";

let journal: ((entry: BootJournalEntry) => void) | null = null;

/**
 * Hand the boot profile, as it accrues, to `write` — synchronously, so each
 * entry is durable before the boot moves on. Installed by the serving entry
 * point before the plugin graph loads (`bin/index.ts`); a host that installs
 * none keeps the profile in memory only. Every checkpoint, every `open`, and
 * each span past `JOURNAL_SPAN_FLOOR_MS` (or in the `load` phase) — but not a
 * span started with `journal: false` (a wave's barrel imports: the wave's
 * span carries its `slowest` instead — a boot's few hundred concurrent
 * imports each past the floor are ~500 synchronous appends on a stalled disk).
 */
export function installBootJournal(
  write: (entry: BootJournalEntry) => void,
): void {
  journal = write;
}

export function profilerStart(
  id: string,
  phase: PhaseId,
  label: string,
  plugin?: string,
  opts?: SpanOptions,
): (detail?: {
  slowest?: readonly { plugin: string; ms: number }[];
}) => number {
  return startSpan(id, phase, label, plugin, opts).end;
}

interface SpanOptions {
  /** What the span holds: journaled as an `open` entry as it starts. */
  members?: readonly string[];
  /** Record the span only when it took at least this long. */
  floorMs?: number;
  /**
   * `false`: keep the span in memory only — one of many concurrent siblings
   * (a wave's barrel imports), summarised by the span around it instead.
   */
  journal?: false;
  /** The span this one is a part of, by its (unique) id. */
  parent?: string;
}

/** `profilerStart`, also answering the span's unique id — what a part names as its `parent`. */
function startSpan(
  id: string,
  phase: PhaseId,
  label: string,
  plugin: string | undefined,
  opts: SpanOptions | undefined,
): {
  uniqueId: string;
  end: (detail?: {
    slowest?: readonly { plugin: string; ms: number }[];
  }) => number;
} {
  const count = idCounts.get(id) ?? 0;
  idCounts.set(id, count + 1);
  const uniqueId = count === 0 ? id : `${id}:${count}`;
  const t0 = performance.now();
  const physFootprintStartMb = footprintMb();
  if (opts?.members !== undefined)
    journal?.({
      e: "open",
      id: uniqueId,
      phase,
      label,
      startMs: Math.round(t0 - bootStart),
      members: opts.members,
    });
  const end = (detail?: {
    slowest?: readonly { plugin: string; ms: number }[];
  }): number => {
    const durationMs = Math.round(performance.now() - t0);
    if (opts?.floorMs !== undefined && durationMs < opts.floorMs)
      return durationMs;
    const span: Span = {
      id: uniqueId,
      phase,
      plugin,
      label,
      startMs: Math.round(t0 - bootStart),
      durationMs,
      physFootprintStartMb,
      physFootprintEndMb: footprintMb(),
      ...(opts?.parent !== undefined && { parent: opts.parent }),
    };
    spans.push(span);
    // A span that journaled its `open` journals its close whatever it took:
    // otherwise a fast step reads, at the journal's end, as the one a killed
    // boot was still in.
    if (
      opts?.journal !== false &&
      (phase === "load" ||
        opts?.members !== undefined ||
        durationMs >= JOURNAL_SPAN_FLOOR_MS)
    )
      journal?.({
        e: "span",
        span,
        ...(detail?.slowest && { slowest: detail.slowest }),
      });
    return durationMs;
  };
  return { uniqueId, end };
}

/**
 * Time a named part of a boot hook: `step(name, work)` runs `work` as a `step`
 * span `<parent>/<name>` under the span it is called in, and hands `work` a
 * `step` of its own for the parts inside it. Every step is kept in the boot
 * profile, and journaled past the journal floor like any span — so a hook
 * over its budget says which part took the time (`debug/boot-budget` puts the
 * hook's steps in its report). Steps may overlap (parts run under
 * `Promise.all`); each is its own wall time.
 *
 * Code a boot hook shares with a later caller (a sweep job re-running the
 * hook's reconcile) takes the `step` as a parameter and is handed
 * `untimedStep` there.
 */
export type BootStep = <T>(
  name: string,
  work: (step: BootStep) => Promise<T>,
) => Promise<T>;

/** What the framework hands every boot hook (`onReadyBlocking` … `onSettled`). */
export interface BootHookContext {
  /** Time a named part of this hook (see `BootStep`). */
  readonly step: BootStep;
  /**
   * Whether this process owns its database's schema (`./schema-role.ts`): the
   * owner token every boot-DDL chokepoint requires, or `verifier` in an `exec`
   * child, which must not change the schema.
   */
  readonly schema: SchemaRole;
}

/** `BootStep` timing nothing: the same code run outside a boot hook. */
export const untimedStep: BootStep = (_name, work) => work(untimedStep);

/** The `step` of the span `parentId` (a hook's, or an outer step's). */
function stepUnder(parentId: string, plugin: string | undefined): BootStep {
  return async (name, work) => {
    // Labelled by its whole path (`onReady:conversations/reconcile/rows`):
    // a boot Gantt lists every hook's steps in one lane.
    const id = `${parentId}/${name}`;
    const { uniqueId, end } = startSpan(id, "step", id, plugin, {
      parent: parentId,
    });
    try {
      return await work(stepUnder(uniqueId, plugin));
    } finally {
      end();
    }
  };
}

/**
 * Open a boot hook's span and the context its hook is handed: the framework's
 * one way to start a per-plugin hook span (`server-core`'s boot stages).
 */
export function profileBootHook(
  id: string,
  phase: PhaseId,
  plugin: string,
  opts?: { members?: readonly string[] },
): { ctx: BootHookContext; end: () => number } {
  const { uniqueId, end } = startSpan(id, phase, plugin, plugin, opts);
  return {
    ctx: {
      step: stepUnder(uniqueId, plugin),
      schema: schemaRoleFor(getBootMode()),
    },
    end: () => end(),
  };
}

/**
 * Record a process-wide memory snapshot at a clean boot-phase boundary.
 * These boundary checkpoints are the authoritative per-phase footprint numbers
 * (per-span deltas inside parallel phases overlap and are only directional).
 */
export function recordMemoryCheckpoint(label: string): void {
  // A host with no heap reader has nothing to record.
  const mem = heapMemory();
  if (mem === null) return;
  const checkpoint: MemoryCheckpoint = {
    label,
    atMs: Math.round(performance.now() - bootStart),
    physFootprintMb: toMb(physFootprintBytes() ?? mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers),
  };
  const cpu = ownCpuMs();
  if (cpu !== null) checkpoint.cpuMs = Math.round(cpu);
  memoryCheckpoints.push(checkpoint);
  journal?.({ e: "checkpoint", checkpoint });
}

/**
 * Stamp the instant this backend became ready — called by `markServerReady()`
 * only, so the profiler's ready instant cannot drift from the flag
 * `/api/health/ready` reports and the gateway hot-swaps on.
 */
export function recordReadyInstant(): void {
  timeToReadyMs = Math.round(performance.now());
}

export function getProfilingData(): {
  spans: Span[];
  totalDurationMs: number;
  memoryCheckpoints: MemoryCheckpoint[];
  /**
   * Where span / checkpoint offsets start, in ms after process start
   * (`performance.timeOrigin`): this module's evaluation. Adding it to
   * `timeOrigin` places an offset on the wall clock.
   */
  bootStartOffsetMs: number;
  /**
   * Ms from process start (`performance.timeOrigin` — the clock the gateway
   * and `boot.jsonl` measure on, NOT the span offsets' axis) to
   * `markServerReady()`: how long the backend took to become ready. `null`
   * until then, and always in a host that never marks ready (`exec`, browser).
   * Post-ready work (`onReady`, the settled phase's warm-up drain) is not in it.
   */
  timeToReadyMs: number | null;
} {
  const totalDurationMs =
    spans.length === 0
      ? 0
      : Math.max(...spans.map((s) => s.startMs + s.durationMs));
  return {
    spans,
    totalDurationMs,
    memoryCheckpoints,
    bootStartOffsetMs: bootStart,
    timeToReadyMs,
  };
}
