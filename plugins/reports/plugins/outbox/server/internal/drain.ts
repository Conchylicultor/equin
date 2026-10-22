import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  OutboxEntrySchema,
  isOutboxEntryName,
  isOutboxTempName,
  type OutboxCode,
  type OutboxEntry,
} from "../../core";
import type { StalenessVerdict } from "./staleness";

/**
 * A temp file older than this was abandoned by a writer that died between its
 * write and its rename. Far above any real write (milliseconds), so a live
 * write is never removed from under its writer.
 */
const ABANDONED_TEMP_MS = 10 * 60_000;

/**
 * How long an entry of a kind main does not register waits for it. Such an
 * entry is not broken: a branch added the kind and has not merged yet, and
 * once it does, main's next drain files it. 14 days is long enough for a
 * branch to merge; past it, main never learned the kind, so the branch was
 * abandoned and the entry is deleted — with a log line, never a crash report.
 */
export const UNKNOWN_KIND_TTL_MS = 14 * 24 * 60 * 60_000;

/**
 * Entry names already logged as waiting for their kind, so a pending entry is
 * logged once per process rather than on every drain. Module-level on purpose:
 * it outlives passes, and a restart logging each one once more is fine.
 */
const loggedPending = new Set<string>();

/** Everything the drain touches outside the directory, injected for tests. */
export interface DrainDeps {
  dir: string;
  /** Record one entry as a report (production: `recordReport`, source `cli`). */
  record(entry: OutboxEntry): Promise<void>;
  /**
   * File an entry that could not be recorded as a crash-style report carrying
   * the error. Called BEFORE the entry is deleted, so if this throws too, the
   * entry stays for the next drain instead of vanishing.
   */
  recordFailure(error: Error, entryName: string): Promise<void>;
  /** Whether main registers a `ReportKind` for `kind` — see UNKNOWN_KIND_TTL_MS. */
  isKnownKind(kind: string): boolean;
  /** The staleness rule — see staleness.ts. Throws when it cannot tell. */
  checkStaleness(code: OutboxCode): Promise<StalenessVerdict>;
  log(line: string): void;
  now?: () => number;
}

/** What one drain pass did, for tests and the log line. */
export interface DrainSummary {
  filed: string[];
  dropped: string[];
  failed: string[];
  /** Left in place: their kind is not registered yet (a branch not merged). */
  pending: string[];
  /** Deleted: their kind stayed unknown past UNKNOWN_KIND_TTL_MS. */
  expired: string[];
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * One entry, start to finish. Returns what became of it; throws only when even
 * its failure could not be recorded (the entry is then left in place).
 */
async function drainEntry(
  name: string,
  deps: DrainDeps,
): Promise<"filed" | "dropped" | "failed" | "pending" | "expired" | "gone"> {
  const path = join(deps.dir, name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // Drains are serialized, so nothing else deletes entries — but a person
    // clearing the directory by hand is not an error worth a report.
    if (isMissing(error)) return "gone";
    throw error;
  }

  let verdict: "filed" | "dropped" | "pending" | "expired";
  try {
    verdict = await settleEntry(
      name,
      OutboxEntrySchema.parse(JSON.parse(raw)),
      deps,
    );
  } catch (error) {
    // Bad JSON, a shape the envelope schema rejects, a payload a KNOWN kind's
    // schema rejects, a staleness check that could not decide: all loud, none
    // retried forever. (An UNKNOWN kind never lands here — see settleEntry.)
    // The entry becomes a report of its own failure, and only then is it
    // deleted.
    const cause = asError(error);
    await deps.recordFailure(
      new Error(
        `report outbox entry ${name} could not be filed: ${cause.message}`,
        { cause },
      ),
      name,
    );
    await unlink(path);
    return "failed";
  }
  if (verdict !== "pending") await unlink(path);
  return verdict;
}

/** A parsed entry's fate. Throws for the loud failures `drainEntry` reports. */
async function settleEntry(
  name: string,
  entry: OutboxEntry,
  deps: DrainDeps,
): Promise<"filed" | "dropped" | "pending" | "expired"> {
  // First, and before the staleness rule: an entry main cannot record yet is
  // not broken, and not worth a git spawn per pass.
  if (!deps.isKnownKind(entry.kind)) {
    const ageMs = (deps.now ?? Date.now)() - entry.occurredAt;
    if (ageMs < UNKNOWN_KIND_TTL_MS) {
      if (!loggedPending.has(name)) {
        loggedPending.add(name);
        deps.log(
          `[report-outbox] left ${name} in place: main registers no "${entry.kind}" ` +
            `report kind yet (written by ${entry.writer.checkout}, presumably on a branch ` +
            "that has not merged). It is filed once the kind reaches main.",
        );
      }
      return "pending";
    }
    loggedPending.delete(name);
    deps.log(
      `[report-outbox] deleted ${name}: its "${entry.kind}" report kind (written by ` +
        `${entry.writer.checkout}) is still unknown to main after ` +
        `${Math.round(UNKNOWN_KIND_TTL_MS / 86_400_000)} days, so the branch that added it was abandoned`,
    );
    return "expired";
  }

  const staleness = entry.code
    ? await deps.checkStaleness(entry.code)
    : ({ kind: "current" } as const);
  if (staleness.kind === "foreign") {
    deps.log(
      `[report-outbox] dropped a "${entry.kind}" report from ${entry.writer.checkout} ` +
        `(pid ${entry.writer.pid}): its branch point ${entry.code?.mergeBase.slice(0, 12)} ` +
        "is not a commit of this repository, so it is about another repository's code",
    );
    return "dropped";
  }
  if (staleness.kind === "stale") {
    deps.log(
      `[report-outbox] dropped a "${entry.kind}" report from ${entry.writer.checkout} ` +
        `(pid ${entry.writer.pid}): main changed ${staleness.changed.join(", ")} ` +
        `since its branch point ${entry.code?.mergeBase.slice(0, 12)}, so it may already be fixed`,
    );
    return "dropped";
  }
  await deps.record(entry);
  return "filed";
}

/** Remove temp files a dead writer left behind — see ABANDONED_TEMP_MS. */
async function sweepAbandonedTemps(
  names: readonly string[],
  deps: DrainDeps,
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  for (const name of names.filter(isOutboxTempName)) {
    const path = join(deps.dir, name);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs < ABANDONED_TEMP_MS) continue;
      await unlink(path);
      deps.log(
        `[report-outbox] removed ${name}: a writer died before renaming it into place`,
      );
    } catch (error) {
      // Renamed into place by its (live) writer between the readdir and here.
      if (!isMissing(error)) throw error;
    }
  }
}

/**
 * Drain the outbox once: every complete entry, oldest first. The caller
 * serializes passes (two concurrent passes would record one entry twice).
 */
export async function drainOutbox(deps: DrainDeps): Promise<DrainSummary> {
  const names = (await readdir(deps.dir)).sort();
  const summary: DrainSummary = {
    filed: [],
    dropped: [],
    failed: [],
    pending: [],
    expired: [],
  };
  for (const name of names.filter(isOutboxEntryName)) {
    const outcome = await drainEntry(name, deps);
    if (outcome !== "gone") summary[outcome].push(name);
  }
  await sweepAbandonedTemps(names, deps);
  return summary;
}
