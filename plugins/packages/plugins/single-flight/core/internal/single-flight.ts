import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  flockTry,
  waitForFlock,
  type HeldFlock,
} from "@plugins/packages/plugins/flock/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/** Who ran (or is running) a flight's work. */
export interface FlightLeader {
  /** The leader's own identity, as its caller named it (an op id). */
  id: string;
  pid: number;
  /** Epoch ms at which it took the lock. */
  startedAt: number;
}

/**
 * How a `singleFlight` call ended. `led`: this caller ran the work itself (it
 * held the lock, possibly after waiting on a leader whose verdict it could not
 * adopt) and gets back whatever `lead` returned. `joined`: another process ran
 * it, and `verdict` is what that run published — `leader` names that run.
 */
export type Flight<V, R> =
  | { role: "led"; result: R }
  | { role: "joined"; leader: FlightLeader; verdict: V };

/**
 * Hand the run's verdict to every waiting joiner. Call at most once, from
 * inside `lead`, once the verdict is known; a run that never calls it (it threw,
 * or decided it has nothing shareable) leaves its joiners to run the work
 * themselves. Synchronous: the verdict is on disk (atomically) when it returns.
 */
export type Publish<V> = (verdict: V) => void;

export interface SingleFlightOptions<V> {
  /**
   * The directory holding this flight family's files: per key,
   * `<sha256(key)>.lock` (the kernel flock), `.leader.json` (who holds it) and
   * `.verdict.json` (the last published verdict). Created if missing. Every
   * process that must coalesce has to name the same directory.
   */
  dir: string;
  /**
   * What makes two requests "the same work". Callers that pass equal keys
   * coalesce; anything that changes the answer (the inputs' content hash, the
   * selection, the flags) must be IN the key, because a joiner adopts the
   * verdict without looking at anything else.
   */
  key: string;
  /** This caller's identity — recorded as the leader if it leads. */
  id: string;
  /**
   * The verdict's shape. A published verdict is parsed with it before it is
   * adopted, so a verdict written by a process running other code (a schema
   * that moved) is never misread — it is simply not adoptable.
   */
  schema: ZodParser<V>;
  /**
   * May a joiner take this verdict as its own result? A verdict that is not
   * (a run that was interrupted, or came back inconclusive) makes the joiner
   * run the work itself, exactly as if there had been no flight.
   */
  adoptable: (verdict: V) => boolean;
  /**
   * Fired when this caller finds the work already in flight and starts waiting
   * on it — before the wait. `leader` is the holder's record, or `null` in the
   * instant between a leader taking the lock and recording itself (display
   * only: what is adopted is decided by the verdict, never by this record).
   */
  onJoin?: (leader: FlightLeader | null) => void;
  /**
   * Stop waiting on an in-flight leader: the wait's child is killed and the
   * call throws `signal.reason`. Does not reach into `lead` — a leading caller
   * owns its own cancellation.
   */
  signal?: AbortSignal;
}

const LeaderSchema = z.object({
  id: z.string(),
  pid: z.number().int(),
  startedAt: z.number(),
});

/** What a leader writes on publish. `nonce` is unique per publish. */
const EnvelopeSchema = z.object({
  nonce: z.string(),
  leader: LeaderSchema,
  verdict: z.unknown(),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * Run `lead` at most once across every process asking for `key` at the same
 * time; the others wait for it and adopt its verdict.
 *
 * **Lead.** The first caller takes `<dir>/<sha256(key)>.lock` with `flockTry`,
 * records itself in `.leader.json`, runs `lead(publish)`, and releases the lock
 * only after `lead` settles — so a published verdict is on disk before any
 * joiner can wake. The kernel releases the lock if the leader dies (SIGKILL
 * included); no pid is consulted for correctness.
 *
 * **Join.** A caller that finds the lock held reads the current verdict file's
 * `nonce` (or notes there is none), fires `onJoin`, and waits for the lock
 * push-based (`waitForFlock`: a child blocked on the flock, woken by the
 * kernel — no polling). Once granted it HOLDS the lock, so no other leader can
 * publish under it, and reads the verdict file again:
 *
 * - a DIFFERENT nonce means a run that was in flight at or after this caller
 *   arrived published it — the leader it found, or one that took the lock after
 *   it (whose run therefore started on the same key, later). If it parses and is
 *   `adoptable`, the caller releases the lock and returns `joined`.
 * - the SAME nonce (or still none) means nothing was published since it
 *   arrived: the leader died, threw, or published nothing. Whatever is on disk
 *   is from a run that ended before this caller came, and is never adopted.
 *
 * In every case but adoption the caller already holds the lock, so it simply
 * KEEPS it and leads — there is no release-and-retry loop, and so no window in
 * which a third process could barge in between "I could not adopt" and "I run".
 *
 * The verdict file is never deleted; staleness is the nonce comparison, not the
 * file's presence. That is what makes the rule immune to a leader that dies
 * between taking the lock and touching any file.
 *
 * `lead` throwing releases the lock and rethrows (no verdict); joiners then
 * lead in turn, which is the right answer for a failure that was not a verdict.
 */
export async function singleFlight<V, R>(
  opts: SingleFlightOptions<V>,
  lead: (publish: Publish<V>) => Promise<R>,
): Promise<Flight<V, R>> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const files = flightFiles(opts.dir, opts.key);

  // "a": create without truncating — the lock file's content is never read.
  const fd = openSync(files.lock, "a");
  if (flockTry(fd)) return runLead(opts, files, fdHold(fd), lead);
  closeSync(fd);

  // Read AFTER seeing the lock held: whatever is on disk now was published by
  // a run that ended before we arrived (or by the current holder, a moment
  // before its release — then we merely run again, never adopt a stale one).
  const seenNonce = readEnvelope(files.verdict)?.nonce ?? null;
  opts.onJoin?.(readLeader(files.leader));
  const held = await waitForFlock(files.lock, { signal });

  let envelope: Envelope | null;
  try {
    envelope = readEnvelope(files.verdict);
  } catch (err) {
    await held.release();
    throw err;
  }
  if (envelope !== null && envelope.nonce !== seenNonce) {
    const parsed = opts.schema.safeParse(envelope.verdict);
    if (parsed.success && opts.adoptable(parsed.data)) {
      await held.release();
      return { role: "joined", leader: envelope.leader, verdict: parsed.data };
    }
  }
  // We hold the lock: lead.
  return runLead(opts, files, held, lead);
}

/**
 * `singleFlight` for a caller that must NEVER wait on another process: lead if
 * the work is not in flight (so others can still join this run), otherwise
 * return `busy` at once and let the caller decide — typically to run the work
 * unshared.
 *
 * For a caller that already holds a resource the in-flight leader may itself
 * be queued for: waiting on that leader would close a cycle (a nested op holds
 * its parent's host grant; a leader still queued for a grant could be waiting
 * on exactly those units).
 */
export async function tryLead<V, R>(
  opts: Pick<SingleFlightOptions<V>, "dir" | "key" | "id">,
  lead: (publish: Publish<V>) => Promise<R>,
): Promise<{ role: "led"; result: R } | { role: "busy" }> {
  const files = flightFiles(opts.dir, opts.key);
  const fd = openSync(files.lock, "a");
  if (!flockTry(fd)) {
    closeSync(fd);
    return { role: "busy" };
  }
  const flight = await runLead(opts, files, fdHold(fd), lead);
  return { role: "led", result: flight.result };
}

/** Create `dir` and name the key's three files in it. */
function flightFiles(dir: string, key: string): FlightFiles {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, createHash("sha256").update(key).digest("hex"));
  return {
    lock: `${base}.lock`,
    leader: `${base}.leader.json`,
    verdict: `${base}.verdict.json`,
  };
}

interface FlightFiles {
  lock: string;
  leader: string;
  verdict: string;
}

async function runLead<V, R>(
  opts: Pick<SingleFlightOptions<V>, "id" | "key">,
  files: FlightFiles,
  held: HeldFlock,
  lead: (publish: Publish<V>) => Promise<R>,
): Promise<{ role: "led"; result: R }> {
  const leader: FlightLeader = {
    id: opts.id,
    pid: process.pid,
    startedAt: Date.now(),
  };
  let open = true;
  let published = false;
  const publish: Publish<V> = (verdict) => {
    if (!open)
      throw new Error(
        `singleFlight(${opts.key}): publish() called after lead settled`,
      );
    if (published)
      throw new Error(`singleFlight(${opts.key}): publish() called twice`);
    published = true;
    const envelope: Envelope = { nonce: randomUUID(), leader, verdict };
    writeAtomic(files.verdict, envelope);
  };
  try {
    writeAtomic(files.leader, leader);
    return { role: "led", result: await lead(publish) };
  } finally {
    open = false;
    // Ours to remove: we hold the lock, so nobody else can have written it. A
    // leader that dies skips this, which is why `readLeader` checks the pid.
    rmSync(files.leader, { force: true });
    await held.release();
  }
}

/** A lock held on one of our own fds. */
function fdHold(fd: number): HeldFlock {
  let released = false;
  const releaseSync = (): void => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
  return {
    releaseSync,
    release: () => {
      releaseSync();
      return Promise.resolve();
    },
  };
}

/** Temp file + rename, so a reader sees the old file or the new one, never half. */
function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function readJson(
  path: string,
): { kind: "absent" } | { kind: "json"; value: unknown } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw err;
  }
  // Every writer replaces the file atomically, so a parse failure is not a
  // torn write but bytes another version of this code wrote — treated by the
  // callers as "no usable record", never as a verdict.
  try {
    return { kind: "json", value: JSON.parse(raw) as unknown };
  } catch (err) {
    if (err instanceof SyntaxError) return { kind: "json", value: undefined };
    throw err;
  }
}

/**
 * The published verdict's envelope, or `null` when there is none this code can
 * read. `null` is a real state here, not a failure stand-in: "no verdict" and
 * "a verdict in a shape this version does not know" both mean the same thing to
 * a joiner — nothing it may adopt — and both compare as "no nonce".
 */
function readEnvelope(path: string): Envelope | null {
  const read = readJson(path);
  if (read.kind === "absent") return null;
  const parsed = EnvelopeSchema.safeParse(read.value);
  return parsed.success ? parsed.data : null;
}

/**
 * The current holder's record, for display. `null` when there is none, it is
 * unreadable, or the pid it names is gone (a leader that died before removing
 * it) — the lock held now is then someone who has not recorded itself yet.
 */
function readLeader(path: string): FlightLeader | null {
  const read = readJson(path);
  if (read.kind === "absent") return null;
  const parsed = LeaderSchema.safeParse(read.value);
  if (!parsed.success || !isPidAlive(parsed.data.pid)) return null;
  return parsed.data;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}
