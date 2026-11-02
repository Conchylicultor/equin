import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { type AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFileSync, writeFileSync } from "node:fs";
import { jobsStateDir } from "../../data-dirs";

// The anti-loop latch, shared by every deliberate exit of the worker pool: the
// slot floor (`forfeit.ts`) and a dead runner (`runner-watch.ts`). An automatic
// restart that fixes nothing is worse than an honest wedge, so past this many
// exits in the window the backend reports and stays up.
//
// See `jobs/data-dirs/index.ts` for why a duration is legitimate HERE and
// nowhere else in this plugin: it governs our own restart policy and makes no
// claim about whether any worker is alive.

export const LATCH_WINDOW_MS = 3_600_000;
export const MAX_TRIPS_PER_WINDOW = 3;

function latchFile(): AppPath {
  return jobsStateDir.file(`${runtimeNamespace()}.json`);
}

/**
 * Record that this worktree is about to exit deliberately, and return how many
 * trips (including this one) fall inside the window.
 *
 * Written BEFORE the exit and synchronously, for the same reason the report is:
 * there is no "after". A failure to read or write is not fatal — the cost is
 * that the budget is re-armed, which risks one extra restart of a backend whose
 * pool is already broken. Losing the exit itself would be worse, so this never
 * throws into the caller.
 */
export function recordTrip(): number {
  const now = Date.now();
  let trips: number[] = [];
  try {
    const raw = readFileSync(latchFile(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { trips?: unknown }).trips)
    ) {
      trips = (parsed as { trips: unknown[] }).trips.filter(
        (t): t is number => typeof t === "number",
      );
    }
  } catch (err) {
    // ENOENT is the ordinary first-ever case. Anything else (a truncated file
    // from a kill mid-write, a corrupt line) is reported and treated as an
    // empty history — the latch is a backstop, and refusing to exit because we
    // could not read it would be the worse failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[jobs] exit latch unreadable, treating as empty:`, err);
    }
  }

  const recent = trips.filter((t) => now - t < LATCH_WINDOW_MS);
  recent.push(now);
  try {
    jobsStateDir.ensure();
    writeFileSync(latchFile(), JSON.stringify({ trips: recent }));
    // eslint-disable-next-line promise-safety/no-bare-catch -- every failure mode here (dir creation, disk IO, a kill mid-write) maps to the same handling, and this runs on the way OUT: the caller's next statement is process.exit(1). Rethrowing would replace a deliberate exit with an unhandled rejection and lose the exit itself, which is strictly worse than losing one latch entry — the cost of that loss is bounded at one extra restart of a backend whose pool is already broken. Same crash-path argument as reports/plugins/engine/server/internal/buffer.ts.
  } catch (err) {
    console.warn(`[jobs] exit latch not persisted:`, err);
  }
  return recent.length;
}
