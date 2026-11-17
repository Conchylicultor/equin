import { activeClaudeAccountId } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import { ClaudeUsageLimitError } from "@plugins/infra/plugins/claude-cli/server";
import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import {
  AUTO_RESUME_MARGIN_MS,
  limitReached,
  type ClaudeUsageRefresh,
} from "../../core";
import { readClaudeUsage } from "./claude-usage";
import { refreshClaudeUsageNow } from "./usage-probe";

// A background job's Claude call, held while the account it runs on is at its
// usage limit: the run SLEEPS (`ctx.sleep` — a durable wait that frees its
// worker slot and resumes on its own) until the limit resets, instead of
// calling, failing and retrying into dead-letters and reports. The account's
// limits are the ones its agents report (runtime-sdk.claude-usage), so a limit
// the app already knows costs no call at all; one it learns from the call
// itself is read on demand (`get_usage`, no model call) and waited out alike.

/**
 * Run `call` (one one-shot Claude call on the active account — `runClaudePrint`
 * / `runClaudeReadOnly`) inside a job, waiting out the account's usage limit:
 *
 * - its limit is known reached → `ctx.sleep` until it resets, then look again;
 * - the call fails with {@link ClaudeUsageLimitError} → re-read that account's
 *   limits; a window now reads full → sleep until it resets and call again;
 *   none does → {@link UnplacedClaudeLimitError} is thrown: a limit the app
 *   cannot place is a fault, and fails the run loudly (it is no
 *   `ClaudeCliError`, so a caller that shrugs off a failed generation does not
 *   absorb it).
 *
 * Every other failure is thrown as it came.
 */
export function heldAtClaudeLimit<T>(
  ctx: Pick<JobCtx, "sleep">,
  call: () => Promise<T>,
): Promise<T> {
  return holdAtLimit(ctx, call, accountLimits);
}

/** Where {@link holdAtLimit} reads an account's limits — swapped in tests. */
export interface LimitReader {
  /** The active account's limit reached now, as last reported. */
  known(): Promise<{ resetsAt: number } | null>;
  /** `err`'s account's limits read now (and recorded for every reader). */
  readNow(err: ClaudeUsageLimitError): Promise<ClaudeUsageRefresh>;
}

const accountLimits: LimitReader = {
  async known() {
    const accountId = await activeClaudeAccountId();
    return limitReached(
      (await readClaudeUsage()).byAccount[accountId],
      Date.now(),
    );
  },
  readNow: (err) => refreshClaudeUsageNow(err.accountId),
};

export async function holdAtLimit<T>(
  ctx: Pick<JobCtx, "sleep">,
  call: () => Promise<T>,
  limits: LimitReader,
): Promise<T> {
  for (;;) {
    const known = await limits.known();
    if (known) {
      await ctx.sleep(untilReset(known.resetsAt));
      continue;
    }
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof ClaudeUsageLimitError)) throw err;
      const read = await limits.readNow(err);
      const reached =
        read.kind === "read" ? limitReached(read.usage, Date.now()) : null;
      if (!reached) throw new UnplacedClaudeLimitError(err, read);
      // The read rewrote the account's usage file, so every other held call
      // sees the limit before it calls.
      await ctx.sleep(untilReset(reached.resetsAt));
    }
  }
}

/** The call hit a usage limit that the account's own limits do not show. */
export class UnplacedClaudeLimitError extends Error {
  constructor(cause: ClaudeUsageLimitError, read: ClaudeUsageRefresh) {
    super(
      `Claude account "${cause.accountId}" answered a usage limit, but its limits read just after show none reached (${read.kind === "read" ? "no window full" : read.reason}): ${cause.message}`,
      { cause },
    );
    this.name = "UnplacedClaudeLimitError";
  }
}

/** How long to sleep: past the reset by the margin auto-resume waits too. */
function untilReset(resetsAt: number): number {
  return Math.max(0, resetsAt + AUTO_RESUME_MARGIN_MS - Date.now());
}
