import { dirname } from "node:path";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/server";
import { retryUntil, fixed } from "@plugins/packages/plugins/retry/core";
import { resolveConversationTranscriptPaths } from "./resolve-chain";
import { readJsonlEventsFromChain } from "./parse-jsonl";
import { transcriptChainSignature } from "./chain-signature";
import { notifySessionTranscriptWrites } from "./session-writes";
import type { JsonlEvent } from "../../core";

// ---------------------------------------------------------------------------
// The generic half: a room over a set of files under CLAUDE_PROJECTS_DIR.
//
// ONE `parcel.subscribe(CLAUDE_PROJECTS_DIR)` covers the whole tree — every
// conversation transcript and every sub-agent transcript beside it. A second
// subscription over the same root would double the native watch cost for
// nothing, so every binding below feeds off this one callback and this one 30s
// reconcile sweep.
// ---------------------------------------------------------------------------

/** A room's value, together with the signature of the files it was read from. */
export interface PathsSnapshot<T> {
  value: T;
  signature: string;
}

/**
 * What a room watches right now — re-derived on every resolve, so the two halves
 * can never disagree about the moment they describe.
 */
export interface WatchTargets {
  /** The files the value is read from, in read order. */
  paths: string[];
  /**
   * Directories whose CONTENTS decide `paths`.
   *
   * Present ⇒ **discovered membership**: an event anywhere inside one of them
   * re-resolves the room before re-reading. That is the only way a file *created*
   * there ever reaches the room at all — routing by exact path (`paths`) drops a
   * file at the very moment it is born, which is every sub-agent's first write.
   *
   * Absent ⇒ **fixed membership**: the file set is named by some other authority
   * (the session-chain table), so an event on a known path can only mean new
   * bytes in a file we already read, never a new file.
   */
  dirs?: string[];
}

export interface WatchSpec<T> {
  /**
   * Globally unique room key. Two subscribers passing the same key share one
   * room, one resolve and one read; the FIRST spec wins, later ones are ignored.
   * Namespace it by binding (`transcript:<id>`, `file:<path>`, …).
   */
  key: string;
  /** Resolve what to watch. Called on creation, on every refresh, and — for a discovered room — on every event. */
  resolve: () => Promise<WatchTargets>;
  /** Read the room's value from the resolved paths. */
  read: (paths: readonly string[]) => Promise<T>;
  /**
   * Refresh group. `refreshWatchTag(tag)` re-resolves and re-processes every room
   * carrying it — how one authority (a recorded session switch) reaches every
   * room derived from it, not just the one that happens to be keyed by its id.
   */
  refreshOn?: string;
}

type Listener = (snapshot: PathsSnapshot<unknown>) => void;

interface Room {
  key: string;
  spec: WatchSpec<unknown>;
  /** Files the value is currently read from. */
  paths: string[];
  /** Keys this room is registered under in the dispatch index. */
  watchKeys: string[];
  /** True while membership is discovered from directories: an event re-resolves. */
  discovered: boolean;
  /** Signature `lastValue` was read under. `""` never matches a real one, so the first process always fans out. */
  lastSignature: string;
  lastValue: unknown;
  subscribers: Set<Listener>;
  abort: AbortController;
}

const rooms = new Map<string, Room>();
/**
 * Dispatch index: a watched key → the rooms registered under it. A filesystem
 * event is matched against BOTH its own path and its dirname, so a fixed-
 * membership room (which registers its files) and a discovered room (which
 * registers its directories) share one map and one lookup.
 */
const watchIndex = new Map<string, Set<string>>();

// Every event is dispatched at once (debounceMs: 0) — a transcript line is
// something a subscriber is waiting to render.
export const transcriptsWatcher = defineFileWatcher({
  name: "transcript-watcher.transcripts",
  description:
    "Watches every Claude Code transcript (.jsonl) under the projects directory and re-reads the conversations and sub-agents whose files changed, re-checking all of them every 30 seconds in case an event was missed.",
  extensions: [".jsonl"],
  debounceMs: 0,
  reconcileMs: 30_000,
});

let watcher: FileWatcher | null = null;

/**
 * What a room's next run must do: `"read"` re-reads its files; `"resolve"`
 * re-resolves its membership first (a discovered room's event, or the
 * reconcile tick).
 */
type RoomWork = "read" | "resolve";

// One run at a time per room; events and ticks landing mid-run fold into one
// trailing run. Each run reads the room's CURRENT files, so a room written a
// line at a time (debounceMs: 0) costs at most one running plus one pending
// run however fast the lines come — and a slow room holds only itself.
const roomRuns = createKeyedCoalescer<Room, RoomWork>({
  run: (room, work) =>
    work.includes("resolve")
      ? runTracked("transcript-watcher:reconcile", () => reconcileRoom(room))
      : runTracked("transcript-watcher:process", () => processRoom(room)),
});

export async function startTranscriptWatcher(): Promise<void> {
  watcher = await transcriptsWatcher.start({
    dirs: [CLAUDE_PROJECTS_DIR],
    onChange: (events) => {
      notifySessionTranscriptWrites(events, CLAUDE_PROJECTS_DIR);
      // Collapse the batch per room FIRST. Parcel delivers many events at once
      // (a sub-agent directory sees one per appended line), and a discovered
      // room re-resolves on each — so processing per event would run one DB
      // chain lookup and one readdir per LINE written.
      const batch = new Set<Room>();
      for (const ev of events)
        for (const room of roomsFor(ev.path)) batch.add(room);
      for (const room of batch) {
        // A discovered room re-resolves first: the event may BE the creation of a
        // file that belongs to it. A fixed-membership room cannot have gained a
        // file, so it only re-reads.
        roomRuns.trigger(room, [room.discovered ? "resolve" : "read"]);
      }
    },
    onReconcile: () => {
      // Belt-and-suspenders for a missed parcel event AND for a missed
      // `refreshConversationChain` call: re-resolving here bounds the staleness of
      // a session switch to one reconcile period even if the status reconciler never notified.
      for (const room of rooms.values()) roomRuns.trigger(room, ["resolve"]);
    },
  });
}

export async function stopTranscriptWatcher(): Promise<void> {
  for (const room of rooms.values()) {
    room.abort.abort();
  }
  rooms.clear();
  watchIndex.clear();
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
}

/** Every room an event on `path` reaches — by the file itself, or by its directory. */
function roomsFor(path: string): Room[] {
  const keys = watchIndex.get(path);
  const dirKeys = watchIndex.get(dirname(path));
  if (!keys && !dirKeys) return [];
  const out: Room[] = [];
  const seen = new Set<string>();
  for (const set of [keys, dirKeys]) {
    if (!set) continue;
    for (const roomKey of set) {
      if (seen.has(roomKey)) continue;
      seen.add(roomKey);
      const room = rooms.get(roomKey);
      if (room) out.push(room);
    }
  }
  return out;
}

/**
 * Subscribe to a set of files under `CLAUDE_PROJECTS_DIR`, re-read whenever they
 * change. Returns the unsubscribe; the room is torn down when its last
 * subscriber leaves.
 */
export function watchPaths<T>(
  spec: WatchSpec<T>,
  onChange: (snapshot: PathsSnapshot<T>) => void,
): () => void {
  // One cast, at the one boundary where a heterogeneous registry meets a typed
  // caller: the room stores `unknown`, and only this closure knows the T that
  // `spec.read` produced.
  const listener: Listener = (snapshot) =>
    onChange(snapshot as PathsSnapshot<T>);

  let room = rooms.get(spec.key);
  if (!room) {
    room = {
      key: spec.key,
      spec,
      paths: [],
      watchKeys: [],
      discovered: false,
      lastSignature: "",
      lastValue: undefined,
      subscribers: new Set(),
      abort: new AbortController(),
    };
    rooms.set(spec.key, room);
    const created = room;
    void runTracked("transcript-watcher:resolve", () =>
      resolveRoom(created).catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error(
          `[transcript-watcher] resolveRoom failed for ${spec.key}`,
          err,
        );
      }),
    );
  } else if (room.lastSignature !== "") {
    // Late subscriber: deliver the current snapshot immediately. Both halves are
    // read here (and written in `processRoom`) together, so they can never be
    // handed out as a mismatched pair.
    const snapshot: PathsSnapshot<unknown> = {
      value: room.lastValue,
      signature: room.lastSignature,
    };
    const created = room;
    queueMicrotask(() => {
      if (created.subscribers.has(listener)) listener(snapshot);
    });
  }
  room.subscribers.add(listener);

  return () => {
    const r = rooms.get(spec.key);
    if (!r) return;
    r.subscribers.delete(listener);
    if (r.subscribers.size === 0) closeRoom(r);
  };
}

/** Re-resolve and re-process every room carrying `tag`. */
export async function refreshWatchTag(tag: string): Promise<void> {
  for (const room of [...rooms.values()]) {
    if (room.spec.refreshOn === tag) await refreshRoom(room);
  }
}

async function resolveRoom(room: Room): Promise<void> {
  const { signal } = room.abort;

  // `retryUntil` retries while its callback resolves null/undefined and rethrows
  // anything it throws. A room with NOTHING to watch — no files and no directory
  // — is waiting on something that has not landed on disk yet (a transcript
  // Claude has not written, a chain with no resolvable session), so map that onto
  // null and keep waiting; a DB or glob failure still surfaces on the first
  // attempt. A discovered room whose directories are known is NOT waiting: its
  // empty file set is a legitimate value ("no sub-agents yet") and must be
  // delivered, not withheld.
  const targets = await retryUntil(
    async () => {
      const resolved = await room.spec.resolve();
      return hasTargets(resolved) ? resolved : null;
    },
    { delay: fixed(1_000), signal },
  );

  registerTargets(room, targets);
  await processRoom(room);
}

function hasTargets(targets: WatchTargets): boolean {
  return targets.paths.length > 0 || (targets.dirs?.length ?? 0) > 0;
}

/**
 * The reconcile sweep's per-room boundary. One room whose targets can't be
 * resolved (DB blip, glob failure) must not abort the sweep for every other room
 * — same reasoning as `processRoom`'s catch.
 */
async function reconcileRoom(room: Room): Promise<void> {
  try {
    await refreshRoom(room);
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.error(`[transcript-watcher] reconcile failed for ${room.key}`, err);
  }
}

async function refreshRoom(room: Room): Promise<void> {
  if (!rooms.has(room.key)) return;
  const targets = await room.spec.resolve();
  // Nothing to watch means the files haven't landed yet (or a room whose initial
  // `resolveRoom` is still retrying). Keep whatever the room already had rather
  // than tearing down a working subscription.
  if (hasTargets(targets)) registerTargets(room, targets);
  await processRoom(room);
}

function registerTargets(room: Room, targets: WatchTargets): void {
  // A discovered room registers its DIRECTORIES: every one of its files lives in
  // one of them, so the dirname lookup covers the files too — and, unlike them,
  // a directory is a key a not-yet-existing file already matches.
  const watchKeys = targets.dirs ?? targets.paths;
  for (const stale of room.watchKeys) {
    if (watchKeys.includes(stale)) continue;
    const set = watchIndex.get(stale);
    if (!set) continue;
    set.delete(room.key);
    if (set.size === 0) watchIndex.delete(stale);
  }
  room.paths = targets.paths;
  room.watchKeys = watchKeys;
  room.discovered = targets.dirs !== undefined;
  for (const key of watchKeys) {
    let set = watchIndex.get(key);
    if (!set) {
      set = new Set();
      watchIndex.set(key, set);
    }
    set.add(room.key);
  }
}

async function processRoom(room: Room): Promise<void> {
  if (!rooms.has(room.key)) return;
  if (room.paths.length === 0 && room.watchKeys.length === 0) return;
  try {
    // Ordering contract (the memo's `prime` precondition): capture the signature
    // BEFORE the read. A change landing mid-read then leaves the signature OLDER
    // than the value it labels, so the next `get` probes a newer signature, misses,
    // and recomputes. That over-invalidates by one needless read; it can never serve
    // a torn value under a matching signature. Capturing it after would invert the
    // skew — the pair would claim a snapshot newer than its value, and every
    // subsequent `get` would hit it.
    //
    // The signature is also the room's SOLE change-detector, replacing the old
    // per-path `Bun.file().lastModified` map. Strictly more sensitive (it also moves
    // on a size-only change and on set growth), and over-firing is safe.
    const signature = await transcriptChainSignature(room.paths);
    if (signature === room.lastSignature) return;
    const value = await room.spec.read(room.paths);
    // Assigned together, AFTER a successful read. The old code stored the mtimes
    // before reading, so a transient read failure permanently dropped those events
    // until the next mtime change.
    room.lastValue = value;
    room.lastSignature = signature;
    fanOut(room, { value, signature });
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.error(
      `[transcript-watcher] processRoom failed for ${room.key}`,
      err,
    );
  }
}

function fanOut(room: Room, snapshot: PathsSnapshot<unknown>): void {
  for (const listener of room.subscribers) {
    try {
      listener(snapshot);
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch (err) {
      console.error("[transcript-watcher] listener threw", err);
    }
  }
}

function closeRoom(room: Room): void {
  room.abort.abort();
  for (const key of room.watchKeys) {
    const set = watchIndex.get(key);
    if (!set) continue;
    set.delete(room.key);
    if (set.size === 0) watchIndex.delete(key);
  }
  rooms.delete(room.key);
}

// ---------------------------------------------------------------------------
// The bindings.
// ---------------------------------------------------------------------------

/**
 * A conversation's events, together with the chain signature they were read under.
 *
 * The signature is captured BEFORE the read, so it describes a snapshot no newer
 * than `events` — `createSignedMemo.prime`'s precondition. A listener may therefore
 * prime a signed memo with the pair directly.
 */
export interface TranscriptSnapshot {
  events: JsonlEvent[];
  signature: string;
}

/**
 * The refresh group of everything derived from one conversation's session chain.
 *
 * A consumer that resolves its own files FROM that chain (the sub-agent index,
 * whose directories sit beside the chain's transcripts) declares this tag, so a
 * recorded session switch reaches it too instead of waiting for the next
 * reconcile sweep.
 */
export function conversationChainTag(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** Watch a conversation's whole session chain, merged and parsed. */
export function watchTranscript(
  conversationId: string,
  onChange: (snapshot: TranscriptSnapshot) => void,
): () => void {
  return watchPaths<JsonlEvent[]>(
    {
      key: `transcript:${conversationId}`,
      refreshOn: conversationChainTag(conversationId),
      // Fixed membership: the session-chain table decides which files these are,
      // and it tells us through `refreshConversationChain`.
      resolve: async () => ({
        paths: await resolveConversationTranscriptPaths(conversationId),
      }),
      read: (paths) => readJsonlEventsFromChain([...paths]),
    },
    ({ value, signature }) => onChange({ events: value, signature }),
  );
}

/**
 * Watch ONE transcript file — a sub-agent's own `agent-<id>.jsonl`, which has the
 * same line shape as a session transcript and parses with the same reader.
 *
 * Fixed membership of exactly one file: a caller that does not yet know the path
 * has nothing to watch here and should watch the directory instead (`watchPaths`
 * with `dirs`), then rebind once the file exists.
 */
export function watchTranscriptFile(
  path: string,
  onChange: (snapshot: TranscriptSnapshot) => void,
): () => void {
  return watchPaths<JsonlEvent[]>(
    {
      key: `file:${path}`,
      resolve: () => Promise.resolve({ paths: [path] }),
      read: (paths) => readJsonlEventsFromChain([...paths]),
    },
    ({ value, signature }) => onChange({ events: value, signature }),
  );
}

/**
 * Re-resolve a conversation's session chain into every live room derived from it,
 * then re-process.
 *
 * The status reconciler calls this the moment it records a new session id, so a subscriber
 * already watching the conversation follows the switch immediately instead of
 * staying pinned to the file the room resolved at subscribe time.
 *
 * No-op when nothing is watching that conversation: the next `watchTranscript`
 * resolves the chain from scratch.
 */
export async function refreshConversationChain(
  conversationId: string,
): Promise<void> {
  await refreshWatchTag(conversationChainTag(conversationId));
}
