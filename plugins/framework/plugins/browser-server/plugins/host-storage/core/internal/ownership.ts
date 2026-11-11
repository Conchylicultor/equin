// ── One owner per storage, and the handoff between builds ───────────────────
//
// PGlite allows one connection per database, so exactly one worker may hold a
// persistent storage. Tabs of one build share it through one SharedWorker, but
// a NEW build has a new worker URL — a different SharedWorker — and a browser
// without SharedWorker falls back to a worker per tab. So the storage is held
// under an exclusive Web Lock, `equin-host:<name>`, for as long as it is open,
// and a worker that finds it held CLAIMS it over a BroadcastChannel of the same
// name, sending the migrations its code knows:
//
// - the holder YIELDS when the claimant knows every migration the holder knows
//   (same or newer code): it ends serving (its tabs are told to reload and
//   never write again), closes the storage, releases the lock;
//   and, when both start from a snapshot, the claimant's is not older than the
//   holder's;
// - otherwise the claimant is OLDER code than the data, and the holder REFUSES:
//   the claimant fails with `StorageNewerThanCodeError`.
//
// No timeout anywhere: the claimant waits on the lock itself, which ends with
// the holder however it ends, and a refusal aborts that wait. A holder that
// takes the lock while claims are in flight announces itself (`held`), so a
// claimant that posted before there was anyone to answer claims again.

import { StorageNewerThanCodeError } from "./errors";

type OwnershipMessage =
  | {
      t: "claim";
      id: string;
      migrations: string[];
      snapshotTakenAt: number | null;
    }
  | { t: "refuse"; to: string }
  | { t: "held" };

/** True when `claimant` knows every migration `holder` knows. */
export function knowsEveryMigration(
  claimant: readonly string[],
  holder: readonly string[],
): boolean {
  const known = new Set(claimant);
  return holder.every((m) => known.has(m));
}

export interface Ownership {
  /** The storage serves: answer claims from now on (one that came earlier is answered now). */
  answerClaims(): void;
  /**
   * The storage is being closed (the host retires) or wiped (Reset): answer
   * no claim from now on — a claimant (the next host generation's worker,
   * started by a tab opened meanwhile) waits on the lock, granted when the
   * close or wipe releases it, and opens what it left. Yielding to it would
   * end this host `superseded` instead and close the storage under the close
   * or wipe already running.
   */
  closing(): void;
  /** Release the lock (the storage is closed); idempotent. */
  release(): void;
}

/**
 * Take the storage's lock, claiming it from a holder that has it.
 * `onSuperseded` runs when a newer (or equal) build claims it from us, once
 * `answerClaims()` was called: it must end serving and close the storage; the
 * lock is released once it settles.
 */
export async function acquireOwnership(opts: {
  name: string;
  migrations: readonly string[];
  /** When the snapshot this code starts a fresh storage from was taken; absent: it has none. */
  snapshotTakenAt: number | undefined;
  onSuperseded: () => Promise<void>;
}): Promise<Ownership> {
  const lockName = `equin-host:${opts.name}`;
  const channel = new BroadcastChannel(lockName);
  const id = globalThis.crypto.randomUUID();
  const claim = (): void =>
    channel.postMessage({
      t: "claim",
      id,
      migrations: [...opts.migrations],
      snapshotTakenAt: opts.snapshotTakenAt ?? null,
    } satisfies OwnershipMessage);

  const refused = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));

  const granted = new Promise<void>((resolve, reject) => {
    navigator.locks
      .request(lockName, { signal: refused.signal }, () => {
        resolve();
        // Held until `release`.
        return held;
      })
      .catch((err: unknown) => {
        if (refused.signal.aborted) {
          reject(
            new StorageNewerThanCodeError(
              "This demo was opened by a newer version in another tab. Reload this tab to continue.",
            ),
          );
        } else reject(err);
      });
  });

  // While waiting: a refusal aborts the wait; a new holder hears our claim again.
  channel.onmessage = (event: MessageEvent<OwnershipMessage>) => {
    const msg = event.data;
    if (msg.t === "refuse" && msg.to === id) refused.abort();
    else if (msg.t === "held") claim();
  };
  claim();
  try {
    await granted;
  } catch (err) {
    channel.close();
    throw err;
  }

  // Holding. A claim is answered only once the storage serves (`answerClaims`,
  // after the host booted on it): yielding mid-open or mid-boot would release
  // the lock under a worker still writing. An incompatible claim is refused at
  // once; a compatible one waits, the latest kept.
  let answering = false;
  let waiting: string | null = null;
  let yielding = false;
  let closing = false;
  const yieldTo = (): void => {
    yielding = true;
    void opts
      .onSuperseded()
      .finally(() => {
        channel.close();
        release();
      })
      .catch((err: unknown) => {
        console.error(
          `[host-storage] ${opts.name}: closing for the claimant failed (the lock is released anyway)`,
          err,
        );
        throw err;
      });
  };
  channel.onmessage = (event: MessageEvent<OwnershipMessage>) => {
    const msg = event.data;
    if (msg.t !== "claim" || yielding || closing) return;
    const olderSnapshot =
      opts.snapshotTakenAt !== undefined &&
      msg.snapshotTakenAt !== null &&
      msg.snapshotTakenAt < opts.snapshotTakenAt;
    if (
      !knowsEveryMigration(msg.migrations, opts.migrations) ||
      olderSnapshot
    ) {
      channel.postMessage({
        t: "refuse",
        to: msg.id,
      } satisfies OwnershipMessage);
      return;
    }
    if (answering) yieldTo();
    else waiting = msg.id;
  };
  channel.postMessage({ t: "held" } satisfies OwnershipMessage);

  return {
    answerClaims() {
      answering = true;
      if (waiting !== null && !yielding && !closing) yieldTo();
    },
    closing() {
      closing = true;
    },
    release() {
      channel.close();
      release();
    },
  };
}
