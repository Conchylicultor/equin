import { eq, sql } from "drizzle-orm";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import type { FanOutGate, ReportKindSpec } from "@plugins/reports/server";
import {
  SITE_REPORT_LIMITS,
  type SiteReportDropReason,
  type SiteReportEntry,
  type SiteReportsResponse,
} from "../../core";
import type { AdmissionGate } from "./admission";
import type { SiteReportsDb } from "./db";
import { siteReportDrops, siteReports } from "./tables";

/** What the intake needs of a report kind: the engine's own identity rules. */
export type IntakeKind = Pick<
  ReportKindSpec,
  "kind" | "schema" | "fingerprint" | "fanOutExempt"
> & { meta: Pick<ReportKindSpec["meta"], "fanOutPerWindow"> };

export interface IntakeLimits {
  windowMs: number;
  maxPending: number;
  maxRows: number;
}

export interface IntakeDeps {
  db: SiteReportsDb;
  /** The kinds this server registers (`ReportKind.getContributions()`). */
  kinds: () => readonly IntakeKind[];
  admission: AdmissionGate;
  fanOut: FanOutGate;
  visitorKey: (ip: string) => Promise<string>;
  now: () => number;
  /** One-shot flush timer, armed by the first entry after a flush. */
  schedule: (fn: () => void, delayMs: number) => void;
  limits?: IntakeLimits;
}

interface PendingRow {
  kind: string;
  source: string;
  message: string;
  data: Record<string, unknown>;
  path: string;
  buildId: string | null;
  commit: string | null;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * A count saturates at int4's ceiling instead of overflowing: one hot
 * fingerprint can add millions an hour, and an out-of-range error would fail
 * the whole flush. Saturated, it still says "at least this many".
 */
const COUNT_MAX = 2_147_483_647;

/** What one flush wrote — the load test's measure of the server's work. */
export interface FlushStats {
  /** Upserts / updates of `site_reports`: one per pending fingerprint. */
  rowStatements: number;
  /** Upserts of `site_report_drops`: one per reason dropped this flush. */
  dropStatements: number;
  /** Fingerprints that minted a new row. */
  inserted: number;
}

export interface SiteReportsIntake {
  submit(
    entries: readonly SiteReportEntry[],
    ip: string,
  ): Promise<SiteReportsResponse>;
  /** Write what is pending (the timer calls it; a test or shutdown may too). */
  flush(): Promise<FlushStats>;
  /** Distinct fingerprints waiting — never above `maxPending`. */
  pendingSize(): number;
}

/**
 * The website's public report intake. Every layer is bounded by construction:
 *
 * 1. the admission gate (per visitor, global; refused → nothing read);
 * 2. each entry identified exactly as the reports engine would (the kind's
 *    schema and fingerprint), a NEW fingerprint admitted through the same
 *    cross-fingerprint fan-out gate (`reports/server`);
 * 3. aggregated in memory (at most `maxPending` fingerprints) and flushed once
 *    per window as ONE upsert per fingerprint — never a row per event;
 * 4. a table of at most `maxRows` rows.
 *
 * Whatever is refused is counted per (window, reason) in `site_report_drops`,
 * written in the same flush. Nothing is queued past these bounds.
 */
export function createSiteReportsIntake(deps: IntakeDeps): SiteReportsIntake {
  const limits = deps.limits ?? SITE_REPORT_LIMITS;
  let pending = new Map<string, PendingRow>();
  let drops = new Map<SiteReportDropReason, number>();
  let armed = false;
  // Flushes run one at a time, so the row cap's count is read fresh by each.
  const flushLock = createKeyedMutex();

  function drop(reason: SiteReportDropReason, n = 1): void {
    drops.set(reason, (drops.get(reason) ?? 0) + n);
    arm();
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    deps.schedule(() => {
      void runTracked("site-reports.flush", flush);
    }, limits.windowMs);
  }

  async function submit(
    entries: readonly SiteReportEntry[],
    ip: string,
  ): Promise<SiteReportsResponse> {
    const now = deps.now();
    const admission = deps.admission.admit(await deps.visitorKey(ip), now);
    if (!admission.admitted) {
      drop(admission.reason, entries.length);
      return { kind: "rate-limited", retryAfterS: admission.retryAfterS };
    }
    const kinds = deps.kinds();
    let accepted = 0;
    let dropped = 0;
    for (const entry of entries) {
      const outcome = await take(entry, kinds, now);
      if (outcome === "accepted") accepted += 1;
      else {
        dropped += 1;
        drop(outcome);
      }
    }
    if (accepted > 0) arm();
    return { kind: "accepted", accepted, dropped };
  }

  async function take(
    entry: SiteReportEntry,
    kinds: readonly IntakeKind[],
    now: number,
  ): Promise<"accepted" | SiteReportDropReason> {
    const spec = kinds.find((k) => k.kind === entry.kind);
    if (!spec) return "unknown-kind";
    const parsed = spec.schema.safeParse(entry.data);
    if (!parsed.success) return "invalid-data";
    const key = `${entry.kind}:${await spec.fingerprint(parsed.data, {
      message: entry.message,
      source: entry.source,
    })}`;
    const held = pending.get(key);
    if (held) {
      held.count += entry.count;
      held.lastSeenAt = now;
      return "accepted";
    }
    if (!spec.fanOutExempt) {
      const admission = deps.fanOut.admit({
        kind: entry.kind,
        fingerprint: key,
        message: entry.message.slice(0, 200),
        fanOutPerWindow: spec.meta.fanOutPerWindow,
      });
      if (!admission.alert) return "fan-out";
    }
    if (pending.size >= limits.maxPending) return "pending-cap";
    pending.set(key, {
      kind: entry.kind,
      source: entry.source,
      message: entry.message,
      data: entry.data,
      path: entry.path,
      buildId: entry.buildId,
      commit: entry.commit,
      count: entry.count,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return "accepted";
  }

  function flush(): Promise<FlushStats> {
    return flushLock.run("flush", flushNow);
  }

  async function flushNow(): Promise<FlushStats> {
    armed = false;
    const rows = pending;
    const dropped = drops;
    pending = new Map();
    drops = new Map();
    const stats: FlushStats = {
      rowStatements: 0,
      dropStatements: 0,
      inserted: 0,
    };
    if (rows.size === 0 && dropped.size === 0) return stats;
    try {
      await write(rows, dropped, stats);
    } catch (err) {
      // What this flush had not written goes back for the next one (within
      // the same caps), so a database error loses nothing it can keep; the
      // error itself still surfaces.
      restore(rows, dropped);
      throw err;
    }
    return stats;
  }

  function restore(
    rows: Map<string, PendingRow>,
    dropped: Map<SiteReportDropReason, number>,
  ): void {
    for (const [key, r] of rows) {
      const held = pending.get(key);
      if (held) {
        held.count += r.count;
        held.firstSeenAt = Math.min(held.firstSeenAt, r.firstSeenAt);
      } else if (pending.size < limits.maxPending) {
        pending.set(key, r);
      } else {
        drops.set("pending-cap", (drops.get("pending-cap") ?? 0) + 1);
      }
    }
    for (const [reason, n] of dropped) {
      drops.set(reason, (drops.get(reason) ?? 0) + n);
    }
    arm();
  }

  // Each row and drop count leaves its map as it is written, so a failure
  // part-way restores only what was not.
  async function write(
    rows: Map<string, PendingRow>,
    dropped: Map<SiteReportDropReason, number>,
    stats: FlushStats,
  ): Promise<void> {
    const [counted] = await deps.db
      .select({ n: sql`count(*)::int`.mapWith(Number) })
      .from(siteReports);
    let rowCount = counted?.n ?? 0;

    for (const [fingerprint, r] of [...rows]) {
      stats.rowStatements += 1;
      const lastSeenAt = new Date(r.lastSeenAt);
      const count = sql`least(${siteReports.count}::bigint + ${r.count}, ${COUNT_MAX})::int`;
      if (rowCount < limits.maxRows) {
        const [written] = await deps.db
          .insert(siteReports)
          .values({
            fingerprint,
            kind: r.kind,
            source: r.source,
            message: r.message,
            data: r.data,
            path: r.path,
            buildId: r.buildId,
            commit: r.commit,
            count: r.count,
            firstSeenAt: new Date(r.firstSeenAt),
            lastSeenAt,
          })
          .onConflictDoUpdate({
            target: siteReports.fingerprint,
            set: { count, lastSeenAt, buildId: r.buildId, commit: r.commit },
          })
          .returning({ inserted: sql`(xmax = 0)`.mapWith(Boolean) });
        rows.delete(fingerprint);
        if (written?.inserted) {
          rowCount += 1;
          stats.inserted += 1;
        }
      } else {
        // At the cap a known fingerprint still counts up; a new one is dropped.
        const updated = await deps.db
          .update(siteReports)
          .set({ count, lastSeenAt })
          .where(eq(siteReports.fingerprint, fingerprint))
          .returning({ fingerprint: siteReports.fingerprint });
        rows.delete(fingerprint);
        if (updated.length === 0) {
          dropped.set("row-cap", (dropped.get("row-cap") ?? 0) + 1);
        }
      }
    }

    const windowStartedAt = new Date(
      Math.floor(deps.now() / limits.windowMs) * limits.windowMs,
    );
    for (const [reason, n] of [...dropped]) {
      stats.dropStatements += 1;
      await deps.db
        .insert(siteReportDrops)
        .values({ windowStartedAt, reason, count: n })
        .onConflictDoUpdate({
          target: [siteReportDrops.windowStartedAt, siteReportDrops.reason],
          set: {
            count: sql`least(${siteReportDrops.count}::bigint + ${n}, ${COUNT_MAX})::int`,
          },
        });
      dropped.delete(reason);
    }
  }

  return { submit, flush, pendingSize: () => pending.size };
}
