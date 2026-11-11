// ── One owner per storage: tabs join it, a newer build takes it ─────────────
//
// PGlite allows one connection per database, so exactly one worker may hold a
// persistent storage. Tabs of one build share it through one SharedWorker —
// but a worker's NAME can differ between tabs (`demo/prestart`'s generations:
// a retiring worker's name is skipped), a NEW build has a new worker URL — a
// different SharedWorker — and a browser without SharedWorker falls back to a
// worker per tab. So the storage is held under an exclusive Web Lock,
// `equin-host:<name>`, for as long as it is open, and a worker that finds it
// held CLAIMS it over a BroadcastChannel of the same name, saying what code it
// runs (its migrations, snapshot and build) and the SharedWorker name it
// serves under. The holder answers, by the claimant's cause:
//
// - its migrations lack one the holder knows, or its snapshot is older: older
//   code than the data — REFUSE; the claimant fails `outdated`;
// - the same build, both SharedWorkers: another tab of the same host — JOIN,
//   at once: the claimant fails `{ kind: "join", worker }` and its pages
//   connect to the holder's worker. A tab never takes a running host from
//   another tab;
// - otherwise — another build, or a browser without SharedWorker (whose tabs
//   cannot share one worker) — YIELD once the storage serves: end serving
//   (`updated` / `unshared`, what the holder's tabs are told), close, release.
//
// No timeout anywhere: the claimant waits on the lock itself, which ends with
// the holder however it ends, and a refusal aborts that wait. A holder that is
// closing (its host retiring) or wiping (Reset) answers nothing: the claimant
// waits for the lock and opens what it left. A holder that takes the lock
// while claims are in flight announces itself (`held`), so a claimant that
// posted before there was anyone to answer claims again.

import { HostRefusedError } from "@plugins/framework/plugins/browser-server/core";
import { StorageNewerThanCodeError } from "./errors";

/** Which code a worker runs, and the SharedWorker name it serves under. */
export interface OwnerIdentity {
  /** The worker's script URL: content-addressed, so equal means the same code. */
  build: string;
  /** Its SharedWorker name; `null` for a dedicated worker (no SharedWorker in this browser). */
  worker: string | null;
}

/** Why the holder yields: what its tabs are told. */
export type YieldReason = "updated" | "unshared";

type OwnershipMessage =
  | {
      t: "claim";
      id: string;
      migrations: string[];
      snapshotTakenAt: number | null;
      identity: OwnerIdentity;
    }
  | { t: "refuse"; to: string }
  | { t: "join"; to: string; worker: string }
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
 * What a holder does with a claim (see the header). Pure: the whole decision,
 * tested on its own.
 */
export function answerClaim(
  holder: {
    migrations: readonly string[];
    snapshotTakenAt: number | undefined;
    identity: OwnerIdentity;
  },
  claim: {
    migrations: readonly string[];
    snapshotTakenAt: number | null;
    identity: OwnerIdentity;
  },
):
  | { kind: "refuse" }
  | { kind: "join"; worker: string }
  | { kind: "yield"; why: YieldReason } {
  const olderSnapshot =
    holder.snapshotTakenAt !== undefined &&
    claim.snapshotTakenAt !== null &&
    claim.snapshotTakenAt < holder.snapshotTakenAt;
  if (
    !knowsEveryMigration(claim.migrations, holder.migrations) ||
    olderSnapshot
  )
    return { kind: "refuse" };
  if (claim.identity.build !== holder.identity.build)
    return { kind: "yield", why: "updated" };
  if (holder.identity.worker !== null && claim.identity.worker !== null)
    return { kind: "join", worker: holder.identity.worker };
  return { kind: "yield", why: "unshared" };
}

/**
 * Take the storage's lock, claiming it from a holder that has it — or fail:
 * `StorageNewerThanCodeError` when the holder's code is newer, a
 * `HostRefusedError` `{ kind: "join" }` when the same host already serves it
 * as a SharedWorker. `onSuperseded(why)` runs when another build (or, without
 * SharedWorker, another tab) claims it from us, once `answerClaims()` was
 * called: it must end serving and close the storage; the lock is released
 * once it settles.
 */
export async function acquireOwnership(opts: {
  name: string;
  migrations: readonly string[];
  /** When the snapshot this code starts a fresh storage from was taken; absent: it has none. */
  snapshotTakenAt: number | undefined;
  identity: OwnerIdentity;
  onSuperseded: (why: YieldReason) => Promise<void>;
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
      identity: opts.identity,
    } satisfies OwnershipMessage);

  const refused = new AbortController();
  /** Why the wait was aborted: the error the claim fails with. */
  let refusal: Error | null = null;
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
        if (refused.signal.aborted && refusal !== null) reject(refusal);
        else reject(err);
      });
  });

  // While waiting: a refusal aborts the wait; a new holder hears our claim again.
  channel.onmessage = (event: MessageEvent<OwnershipMessage>) => {
    const msg = event.data;
    if (refusal !== null) return;
    if (msg.t === "refuse" && msg.to === id) {
      refusal = new StorageNewerThanCodeError(
        "another tab's worker holds the storage at newer code",
      );
      refused.abort();
    } else if (msg.t === "join" && msg.to === id) {
      refusal = new HostRefusedError(
        { kind: "join", worker: msg.worker },
        `the same host already serves it as "${msg.worker}"`,
      );
      refused.abort();
    } else if (msg.t === "held") claim();
  };
  claim();
  try {
    await granted;
  } catch (err) {
    channel.close();
    throw err;
  }

  // Holding. A tab of the same host is told to join at once (it may connect
  // while this one still boots). A yield is answered only once the storage
  // serves (`answerClaims`, after the host booted on it): yielding mid-open or
  // mid-boot would release the lock under a worker still writing — so it
  // waits, the latest kept. An incompatible claim is refused at once.
  let answering = false;
  let waiting: YieldReason | null = null;
  let yielding = false;
  let closing = false;
  const yieldTo = (why: YieldReason): void => {
    yielding = true;
    void opts
      .onSuperseded(why)
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
    const answer = answerClaim(opts, msg);
    switch (answer.kind) {
      case "refuse":
        channel.postMessage({
          t: "refuse",
          to: msg.id,
        } satisfies OwnershipMessage);
        return;
      case "join":
        channel.postMessage({
          t: "join",
          to: msg.id,
          worker: answer.worker,
        } satisfies OwnershipMessage);
        return;
      case "yield":
        if (answering) yieldTo(answer.why);
        else waiting = answer.why;
        return;
    }
  };
  channel.postMessage({ t: "held" } satisfies OwnershipMessage);

  return {
    answerClaims() {
      answering = true;
      if (waiting !== null && !yielding && !closing) yieldTo(waiting);
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
