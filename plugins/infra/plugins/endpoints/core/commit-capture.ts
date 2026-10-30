// The COMMIT ACK of a predicted write — design in
// research/2026-10-28-global-endpoint-prediction-decision.md §3 (`increment`).
//
// A predicted write's prediction may declare no field to compare (an
// increment, an upsert with no `set`, a filter-targeted patch, a value): the
// client cannot tell from a row whether the server already holds the write,
// so it confirms CAUSALLY instead — once a tuple's own frames have provably
// seen the write's commit (`network/live`'s overlay). That needs the commit's
// transaction ids, which only the server knows: `implement` runs every
// predicted endpoint's handler inside a COMMIT CAPTURE and stamps the ids of
// the transactions it committed on the response (`COMMITS_HEADER`). The
// handler remembers nothing.
//
// This plugin sits below the database, so the capture is a seam: the host's
// database installs it (`database/server`), and a host without one — or one
// that cannot attribute commits to a request (no async context) — leaves the
// default, which captures nothing: the response carries no header, and the
// client falls back to confirming at the ack.

/**
 * The response header carrying the writes (comma-joined, in order) a predicted
 * endpoint's handler made: the transactions it committed (xid8 decimal text)
 * and the external writes it notified (`mintExternalWriteId`). Absent when it
 * made none the capture could see.
 */
export const COMMITS_HEADER = "x-equin-commits";

const TRANSACTION_ID = /^\d+$/;
const EXTERNAL_WRITE_ID = /^e[0-9a-f]+\.\d+$/;

/**
 * Whether a write id is a Postgres transaction (xid8 decimal text) — the only
 * kind a snapshot watermark can be compared against. An external write is
 * acked by its tuple's own frame (`ackTx`) alone.
 */
export function isTransactionId(id: string): boolean {
  return TRANSACTION_ID.test(id);
}

// The boot this process mints external write ids in: a tab outlives a server
// restart, and its ack rings would otherwise take a restarted counter's `.1`
// for the last boot's.
const BOOT = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12);
let externalWrites = 0;

/**
 * A fresh id for a write to a source outside Postgres (a config file): what an
 * external value's `notify()` made inside a captured handler is acked by — the
 * handler's response names it, and the recompute it triggers carries it as
 * `ackTx`. Unique per process, never a transaction id.
 */
export function mintExternalWriteId(): string {
  externalWrites++;
  return `e${BOOT}.${externalWrites}`;
}

/** How a host attributes commits to the request that made them. */
export interface CommitCapture {
  /**
   * Run `fn`, answering its value and the ids of the transactions it
   * committed (and only those: a transaction rolled back, or one another
   * request made meanwhile, is not in it).
   */
  run<T>(
    fn: () => Promise<T>,
  ): Promise<{ value: T; commits: readonly string[] }>;
}

const NO_CAPTURE: CommitCapture = {
  run: async (fn) => ({ value: await fn(), commits: [] }),
};

let capture: CommitCapture = NO_CAPTURE;

/** Install the host's commit capture — the database's, at boot (`database/server`). */
export function installCommitCapture(next: CommitCapture): void {
  capture = next;
}

/** Run a predicted endpoint's handler under the installed capture. */
export function captureCommits<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; commits: readonly string[] }> {
  return capture.run(fn);
}

/** The header's value, or `null` for none (nothing to stamp). */
export function commitsHeaderValue(commits: readonly string[]): string | null {
  return commits.length === 0 ? null : commits.join(",");
}

/**
 * The write ids a response carries, `[]` for none. A malformed value throws:
 * the header is ours, so a garbled one is a server bug, not a missing ack.
 */
export function readCommitsHeader(res: Response): readonly string[] {
  const raw = res.headers.get(COMMITS_HEADER);
  if (raw === null || raw === "") return [];
  const ids = raw.split(",");
  for (const id of ids) {
    if (!TRANSACTION_ID.test(id) && !EXTERNAL_WRITE_ID.test(id)) {
      throw new Error(
        `${COMMITS_HEADER}: ${JSON.stringify(raw)} is not a comma-joined list of transaction ids and external write ids`,
      );
    }
  }
  return ids;
}
