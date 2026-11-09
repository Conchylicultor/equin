import { z } from "zod";

/**
 * The file the fs-latency monitor appends one tick to every 30 s, relative to
 * the monitors' log directory (`debug`'s `monitorLogsDir`). The monitor is this
 * plugin's `monitor` sub-plugin: it builds every line as a {@link WrittenTick},
 * which tsc holds to the reader's {@link MonitorTickSchema} below.
 */
export const FS_LATENCY_LOG_NAME = "fs-latency.jsonl";

/** How often the monitor ticks (its login service's schedule, launchd's `StartInterval`). */
export const MONITOR_INTERVAL_MS = 30_000;

const ProcSchema = z.object({
  pid: z.number(),
  age_s: z.number(),
  /** Resident size (MB, from ps), from 2026-11-09. */
  rss_mb: z.number().optional(),
});

/**
 * Why a root daemon whose plist is installed is not the monitor: its plist is
 * empty, does not parse, is not loaded by launchd, or is loaded and wrote no
 * tick lately. The user agent ticks in its place and says which.
 */
export const ROOT_DAEMON_PROBLEMS = [
  "empty",
  "invalid",
  "not-loaded",
  "not-writing",
] as const;
export type RootDaemonProblem = (typeof ROOT_DAEMON_PROBLEMS)[number];

export const RootDaemonStatusSchema = z.object({
  problem: z.enum(ROOT_DAEMON_PROBLEMS),
  /** The installed plist. */
  plist: z.string(),
  /** The root daemon's own stdout/stderr log. */
  stdio: z.string(),
  /** The one command that reinstalls it (sudo, from any directory). */
  fix: z.string(),
});
export type RootDaemonStatus = z.infer<typeof RootDaemonStatusSchema>;

/**
 * One line of `fs-latency.jsonl`, reduced to what the detector reads (unknown
 * keys are dropped). Fields the monitor added over time are optional, so the
 * recorded history from 2026-11-03 parses as it was written: the first tick
 * has no rates (they are deltas), `corecaptured` arrived on 2026-11-04 16:00,
 * `daemon_procs` later, and the root-only keys exist only while it runs as root.
 */
export const MonitorTickSchema = z.object({
  /** Epoch seconds. */
  t: z.number(),
  iso: z.string(),
  /** Slowest single cold probe op of the tick (ms), either tier. */
  max_op_ms: z.number(),
  fg: z.object({ max_op: z.number(), rename_max: z.number().optional() }),
  bg: z.object({ max_op: z.number(), rename_max: z.number().optional() }),
  /** Per canary group: page residency vs seconds since it was last read. */
  canary: z.array(z.object({ age_s: z.number(), resident: z.number() })),
  load1: z.number(),
  /** %CPU of each watched system daemon (fseventsd, syspolicyd, …). */
  daemon_cpu: z.record(z.string(), z.number()),
  new_vnodes_s: z.number().optional(),
  disk_read_ops_s: z.number().optional(),
  disk_read_mb_s: z.number().optional(),
  /** Device time per read op (ms); null when the tick read nothing. */
  disk_read_ms_per_op: z.number().nullable().optional(),
  /** Legacy (2026-11-04): corecaptured alone, before `daemon_procs`. */
  corecaptured: ProcSchema.nullable().optional(),
  /** pid and age of each watched daemon that is running. */
  daemon_procs: z.record(z.string(), ProcSchema).optional(),
  /** Root only: top disk readers since the last tick (MB/s by process name). */
  disk_readers_mb_s: z.record(z.string(), z.number()).nullable().optional(),
  /** User agent only: a root daemon is installed but not writing (absent when none is installed). */
  root_daemon: RootDaemonStatusSchema.optional(),
  /** Processes in uninterruptible wait as the tick ran, by name (from 2026-11-05). */
  uninterruptible: z.record(z.string(), z.number()).optional(),
});
export type MonitorTick = z.infer<typeof MonitorTickSchema>;

/**
 * Parse one complete line of the log. Throws on a line that is not a tick: the
 * monitor writes each line in one append, so a malformed one is a format
 * change on its side that this schema must follow, not noise to skip.
 */
export function parseTickLine(line: string): MonitorTick {
  return MonitorTickSchema.parse(JSON.parse(line));
}

/** A reader field the monitor no longer writes, kept so the recorded history parses. */
type LegacyTickField = "corecaptured";

/** One cold-probe tier's readings (ms). */
export interface ProbeReading {
  lstat_p50: number;
  lstat_max: number;
  lstat_sum: number;
  readdir500: number;
  /** The slowest lstat or readdir: the cold metadata ops (`metadata-stall`). */
  max_op: number;
  /**
   * The slowest of a burst of renames of one file within its own directory.
   * Not part of `max_op`: a rename waits on the volume's rename serialization
   * (a bulk directory-tree mutation elsewhere on the volume — `bun install`
   * moving package dirs, `rm -rf` of a tree — holds every rename), not on a cold
   * lookup, so it is its own rule (`rename-stall`).
   */
  rename_max: number;
}

type DaemonProc = z.infer<typeof ProcSchema>;

/**
 * One line exactly as the monitor writes it today — what the reader parses
 * plus the evidence it only carries along (`report.ts`, a human reading the
 * log). Held to the reader by the two assertions below: every line written
 * parses, and every field the reader knows (but the legacy one) is written, so
 * a renamed or added reader field is a tsc error in the monitor, not a
 * detector that silently reads `undefined`.
 */
export interface WrittenTick {
  t: number;
  iso: string;
  fg: ProbeReading;
  bg: ProbeReading;
  max_op_ms: number;
  stall: boolean;
  canary: { age_s: number; resident: number }[];
  vnodes: number;
  maxvnodes: number;
  /** Rates are deltas: absent on a monitor's first tick. */
  new_vnodes_s?: number;
  recycled_vnodes_s?: number;
  disk_read_ops_s?: number;
  disk_write_ops_s?: number;
  disk_read_mb_s?: number;
  disk_read_ms_per_op?: number | null;
  load1: number;
  daemon_cpu: Record<string, number>;
  daemon_procs: Record<string, Required<DaemonProc>>;
  /** The current FSEvents event id (FSEventsGetCurrentEventId), from 2026-11-09. */
  fsevents_event_id: number;
  /** Root only (absent otherwise); null on the first root tick (no delta yet). */
  disk_readers_mb_s?: Record<string, number> | null;
  disk_read_attributed_mb_s?: number | null;
  disk_read_born_mb_s?: number | null;
  fseventsd_logs?: string[] | null;
  /** Root only: the `fs_usage` capture taken on a stall. */
  incident?: string;
  /** User agent only, while a root daemon's plist is installed but it does not write. */
  root_daemon?: RootDaemonStatus;
  /** Processes in uninterruptible wait (ps state U) as the tick ran: count by name, the busiest few. */
  uninterruptible: Record<string, number>;
}

type Holds<T extends true> = T;
/** Every line the monitor writes parses as a tick. */
export type _WrittenTickParses = Holds<
  WrittenTick extends z.input<typeof MonitorTickSchema> ? true : false
>;
/** Every field the reader reads is one the monitor writes. */
export type _ReaderFieldsWritten = Holds<
  [Exclude<keyof MonitorTick, keyof WrittenTick | LegacyTickField>] extends [
    never,
  ]
    ? true
    : false
>;
