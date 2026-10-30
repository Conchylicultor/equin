import { z } from "zod";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it, the web dispatches its `Reports.KindView` on it, and the check
 * runner files under it. A second spelling on any side would leave the others
 * silently unmatched.
 */
export const CHECK_THREAD_STALL_KIND = "check-thread-stall";

/**
 * A stall whose code HELD the thread at least this long files a `stall` report
 * — held, not late: a tick also fires late when the OS does not schedule the
 * thread (a check pass at background priority on a busy host), and that is no
 * code's doing. Held is the thread's own CPU time plus its synchronous-syscall
 * wait (`StallHeld` in the check runner's thread watch). Where the platform has
 * no thread CPU clock, `lateMs` is compared instead.
 *
 * The thresholds are the "Check pass speed" track's TARGETS, not today's
 * numbers (stretch: the longest stall under 2 s; the total under 20 s) — so a
 * report means "this pass missed the target", and once the remaining stalls
 * are fixed, a new report means a regression.
 */
export const STALL_REPORT_MS = 2_000;

/** A run whose stalls add up to at least this much HELD time files one `total` report. See above. */
export const TOTAL_REPORT_MS = 20_000;

/** One owner of the thread, with the first frames of one real stack. */
const OwnerSchema = z.object({
  /** `check <plugin>`, `shared <fn @ path>`, `import`, or `native <leaf>`. */
  owner: z.string(),
  samples: z.number().int(),
  /** Innermost first, as `name @ path:line` frame keys. */
  example: z.array(z.string()),
});
export type CheckThreadStallOwner = z.infer<typeof OwnerSchema>;

/**
 * Sample counts by what the thread was physically doing (`blocking-io`,
 * `process`, `module-load`, `cpu`, `native`). A record rather than the closed
 * set restated: the set belongs to the check runner's attribution, and a new
 * bucket there must not make old rows unreadable here.
 */
const KindsSchema = z.record(z.string(), z.number());

const CpuSchema = z.object({ userMs: z.number(), systemMs: z.number() });

/**
 * How much of a stall code held the thread vs the OS starved it. Optional on
 * read only: rows and outbox entries written before the split lack it; the
 * check runner always writes it.
 */
const HeldSchema = z.discriminatedUnion("measured", [
  z.object({
    measured: z.literal(true),
    /** The main thread's own CPU time over the stall. */
    threadCpuMs: z.number(),
    /** Estimated time in a synchronous syscall (blocking-io sample share × lateMs). */
    blockedMs: z.number(),
    heldMs: z.number(),
    starvedMs: z.number(),
  }),
  /** No thread CPU clock on the writer's platform. */
  z.object({ measured: z.literal(false) }),
]);

const RunHeldSchema = z.object({
  heldMs: z.number(),
  starvedMs: z.number(),
  longestHeldMs: z.number(),
});

const RunFields = {
  /** The checkout the check run was checking. */
  worktree: z.string(),
  runId: z.string(),
  /** The run's transcript (`check-<runId>.log`), when the run writes one. */
  transcript: z.string().nullable(),
};

/** One stall of ≥ `STALL_REPORT_MS`. Fingerprinted by `topOwner`. */
export const CheckThreadStallSchema = z.object({
  trigger: z.literal("stall"),
  ...RunFields,
  /** How late the watch's tick fired — the part the thread was known busy. */
  lateMs: z.number(),
  /** From the run's start to when the stall began. */
  offsetMs: z.number(),
  /** The busiest owner's label, or `(no samples)` when none was taken. */
  topOwner: z.string(),
  /** Every check in flight during the stall — the link from a `shared` owner to its callers. */
  running: z.array(z.string()),
  bootstrap: z.array(z.string()),
  samples: z.number().int(),
  /** The top 3 owners, busiest first. */
  owners: z.array(OwnerSchema),
  kinds: KindsSchema,
  cpu: CpuSchema,
  held: HeldSchema.optional(),
});

/** A run whose stalls totalled ≥ `TOTAL_REPORT_MS`. One row, fingerprint `total`. */
export const CheckThreadTotalSchema = z.object({
  trigger: z.literal("total"),
  ...RunFields,
  /** Σ `lateMs` over the run's stalls. */
  stalledMs: z.number(),
  stallCount: z.number().int(),
  longestLateMs: z.number(),
  /** Who held the thread across every stall window together, busiest first. */
  stallOwners: z.array(OwnerSchema),
  /** Over the whole run, stall or not. */
  kinds: KindsSchema,
  cpu: CpuSchema,
  /** Σ held / starved over the stalls; null where the writer had no thread
   *  CPU clock, absent on a row written before the split. */
  held: RunHeldSchema.nullable().optional(),
});

export const CheckThreadStallPayloadSchema = z.discriminatedUnion("trigger", [
  CheckThreadStallSchema,
  CheckThreadTotalSchema,
]);
export type CheckThreadStallPayload = z.infer<
  typeof CheckThreadStallPayloadSchema
>;

/** The label of an owner-less stall — no sample landed in its window. */
export const NO_SAMPLES_OWNER = "(no samples)";

/**
 * One row per top owner for a stall — each new stall by the same owner bumps
 * that row's count — and one row for every over-budget run.
 */
export function checkThreadStallFingerprint(
  d: CheckThreadStallPayload,
): string {
  return d.trigger === "stall"
    ? `${CHECK_THREAD_STALL_KIND}:${d.topOwner}`
    : `${CHECK_THREAD_STALL_KIND}:total`;
}

/** The busiest kind in a split, or null when no sample was taken. */
export function dominantKind(kinds: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [kind, count] of Object.entries(kinds)) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/** `4213` → `4.2 s`. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The one-line summary — the report row's `message`, and the KindView's text:
 * `check thread stalled 4.2 s — check plugin-boundaries (blocking-io)`.
 */
export function checkThreadStallMessage(d: CheckThreadStallPayload): string {
  const kind = dominantKind(d.kinds);
  if (d.trigger === "stall") {
    const head =
      d.held?.measured === true
        ? `check thread held ${formatSeconds(d.held.heldMs)} (of a ${formatSeconds(d.lateMs)} stall)`
        : `check thread stalled ${formatSeconds(d.lateMs)}` +
          (d.held?.measured === false ? " (held time unmeasured)" : "");
    return `${head} — ${d.topOwner}` + (kind !== null ? ` (${kind})` : "");
  }
  const top = d.stallOwners[0]?.owner;
  const head = d.held
    ? `check run held its thread ${formatSeconds(d.held.heldMs)} over ${d.stallCount} stalls ` +
      `(${formatSeconds(d.stalledMs)} late)`
    : `check run stalled ${formatSeconds(d.stalledMs)} in total over ${d.stallCount} stalls`;
  return head + (top !== undefined ? ` — mostly ${top}` : "");
}
