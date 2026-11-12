import { dirname } from "node:path";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/server";
import { resolveConversationTranscriptPaths } from "./resolve-chain";
import { readChain, type ChainRead } from "./parse-jsonl";
import { transcriptChainState } from "./chain-signature";
import { notifySessionTranscriptWrites } from "./session-writes";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

// ---------------------------------------------------------------------------
// The generic half: a room over a set of files under CLAUDE_PROJECTS_DIR.
//
// ONE `parcel.subscribe(CLAUDE_PROJECTS_DIR)` covers the whole tree — every
// conversation transcript and every sub-agent transcript beside it. A second
// subscription over the same root would double the native watch cost for
// nothing, so every binding below feeds off this one callback (and its one
// dropped-events sweep).
// ---------------------------------------------------------------------------

/** A room's value, together with the signature of the files it was read from. */
export interface PathsSnapshot<T> {
  value: T;
  signature: string;
  /**
   * When the files last changed (their newest mtime) — present when this read
   * followed one before it (a change the room saw), absent on its first read.
   */
  changedAt?: number;
  /**
   * When a watch heard that write (wall-clock epoch ms), beside `changedAt`
   * only: the latest hearing among the events this read followed. Absent when
   * no watch event led to the read (a refresh) or the read saw a write newer
   * than any it heard of (read before the watch reported it — no watch delay).
   */
  heardAt?: number;
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
  /**
   * Read the room's value from the resolved paths. `previous` is the value it
   * last read (undefined on the first read), for a reader that continues from
   * it rather than starting over — a transcript reads only what was appended.
   */
  read: (paths: readonly string[], previous: T | undefined) => Promise<T>;
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
  /** The newest mtime `lastValue` was read at — a later read's `changedAt` must pass it. */
  lastChangedAt: number | undefined;
  /** The files a fixed-membership room follows over kqueue (see `followRoom`); empty when none. */
  followed: string[];
  /** The open follow of `followed`, once started. */
  follow: FileWatcher | null;
  /** Follow (re)starts and stops, one after another. */
  following: Promise<void>;
}

const rooms = new Map<string, Room>();
/**
 * Dispatch index: a watched key → the rooms registered under it. A filesystem
 * event is matched against BOTH its own path and its dirname, so a fixed-
 * membership room (which registers its files) and a discovered room (which
 * registers its directories) share one map and one lookup.
 */
const watchIndex = new Map<string, Set<string>>();

// The FILES of a fixed-membership room (a conversation's session chain, one
// sub-agent's transcript), followed per write over kqueue — milliseconds,
// whatever fseventsd is doing. The tree watch below rides FSEvents, which a
// loaded fseventsd delivers seconds to minutes late (2026-11-09: 0.5–14 s, and
// one transcript line ~60 s): a transcript line is the thing a user waits on,
// and its path is known. The tree watch stays for what has no path yet — a
// discovered room's new files, a session's birth (`notifySessionTranscriptWrites`)
// — and as a second trigger (a room whose signature has not moved returns at
// once). Cost: one descriptor per followed file + one per directory, for rooms
// someone is subscribed to.
export const transcriptFollowsWatcher = defineFileWatcher({
  name: "transcript-watcher.followed-files",
  description:
    "Follows every write to the transcript files a watched conversation or sub-agent is read from, so a new line is heard in milliseconds rather than when the folder watch's FSEvents stream gets to it.",
  writesWhileOpen: true,
  debounceMs: 0,
});

// Every event is dispatched at once (debounceMs: 0) — a transcript line is
// something a subscriber is waiting to render.
export const transcriptsWatcher = defineFileWatcher({
  name: "transcript-watcher.transcripts",
  description:
    "Watches every Claude Code transcript (.jsonl) under the projects directory and re-reads the conversations and sub-agents whose files changed, re-checking all of them when the watch reports dropped events.",
  extensions: [".jsonl"],
  debounceMs: 0,
});

let watcher: FileWatcher | null = null;

/**
 * What a room's next run must do: `"read"` re-reads its files; `"resolve"`
 * re-resolves its membership first (a discovered room's event, or a
 * dropped-events report).
 */
interface RoomWork {
  kind: "read" | "resolve";
  /**
   * When the watch event behind this work was heard (epoch ms; absent for a
   * refresh or a dropped-events sweep) — the moment its batch reached this
   * watcher's reaction (debounce 0: at once, but after any reaction still
   * running), so the watch's delivery can be split from the read after it.
   */
  heardAt?: number;
}

/** The latest hearing among a run's work, if a watch event led to it. */
function heardAtOf(work: readonly RoomWork[]): number | undefined {
  let latest: number | undefined;
  for (const w of work)
    if (w.heardAt !== undefined && (latest === undefined || w.heardAt > latest))
      latest = w.heardAt;
  return latest;
}

// One run at a time per room; events and ticks landing mid-run fold into one
// trailing run. Each run reads the room's CURRENT files, so a room written a
// line at a time (debounceMs: 0) costs at most one running plus one pending
// run however fast the lines come — and a slow room holds only itself.
const roomRuns = createKeyedCoalescer<Room, RoomWork>({
  run: (room, work) =>
    work.some((w) => w.kind === "resolve")
      ? runTracked("transcript-watcher:reconcile", () =>
          reconcileRoom(room, heardAtOf(work)),
        )
      : runTracked("transcript-watcher:process", () =>
          processRoom(room, heardAtOf(work)),
        ),
});

export async function startTranscriptWatcher(): Promise<void> {
  watcher = await transcriptsWatcher.start({
    dirs: [CLAUDE_PROJECTS_DIR],
    onChange: (events) => {
      const heardAt = Date.now();
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
        roomRuns.trigger(room, [
          { kind: room.discovered ? "resolve" : "read", heardAt },
        ]);
      }
    },
    onLost: () => {
      // The watch dropped events: any room may have missed a write or a new
      // file. (A session switch is not this path's job: the chain's one writer,
      // the status reconciler, calls `refreshConversationChain` right after it.)
      for (const room of rooms.values())
        roomRuns.trigger(room, [{ kind: "resolve" }]);
    },
  });
}

export async function stopTranscriptWatcher(): Promise<void> {
  const open = [...rooms.values()];
  for (const room of open) closeRoom(room);
  await Promise.all(open.map((room) => room.following));
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
  // Two casts, at the one boundary where a heterogeneous registry meets a typed
  // caller: the room stores `unknown`, and only this closure knows the T that
  // `spec.read` produced — and is handed back as `previous`, since the room
  // only ever passes `read` its own last value.
  const listener: Listener = (snapshot) =>
    onChange(snapshot as PathsSnapshot<T>);
  const roomSpec = spec as unknown as WatchSpec<unknown>;

  let room = rooms.get(spec.key);
  if (!room) {
    room = {
      key: spec.key,
      spec: roomSpec,
      paths: [],
      watchKeys: [],
      discovered: false,
      lastSignature: "",
      lastValue: undefined,
      subscribers: new Set(),
      lastChangedAt: undefined,
      followed: [],
      follow: null,
      following: Promise.resolve(),
    };
    rooms.set(spec.key, room);
    const created = room;
    void runTracked("transcript-watcher:resolve", () => refreshRoom(created));
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

function hasTargets(targets: WatchTargets): boolean {
  return targets.paths.length > 0 || (targets.dirs?.length ?? 0) > 0;
}

/**
 * The dropped-events sweep's per-room boundary. One room whose targets can't be
 * resolved (DB blip, glob failure) must not abort the sweep for every other room
 * — same reasoning as `processRoom`'s catch.
 */
async function reconcileRoom(room: Room, heardAt?: number): Promise<void> {
  try {
    await refreshRoom(room, heardAt);
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.error(`[transcript-watcher] reconcile failed for ${room.key}`, err);
  }
}

/**
 * Resolve a room's targets and re-read it: the room's creation, a refresh of its
 * tag, and the dropped-events sweep all run this one step.
 *
 * A room with NOTHING to watch — no files and no directory — is waiting on
 * something that has not landed on disk yet (a transcript Claude has not
 * written, a chain with no resolvable session). It stays PENDING: registered
 * nowhere, read never, until a push wakes it. No timer re-asks — every room
 * that can resolve empty is derived from a conversation's session chain and
 * carries its `refreshOn` tag, and the status reconciler fires that tag the
 * moment it records a session id, which it only does once that session's file
 * exists (its adoption gate), right after recording it. (This used to be a 1 s `retryUntil` loop: one chain lookup per second
 * per pending room, for as long as Claude took to start — or for hours, for a
 * conversation whose transcript never lands.)
 *
 * A pending refresh of a room that already has targets keeps them rather than
 * tearing down a working subscription. A discovered room whose directories are
 * known is NOT pending: its empty file set is a legitimate value ("no sub-agents
 * yet") and is delivered. A DB or glob failure throws to the caller.
 */
async function refreshRoom(room: Room, heardAt?: number): Promise<void> {
  if (rooms.get(room.key) !== room) return;
  const targets = await room.spec.resolve();
  // Closed (or replaced) while resolving: registering now would leak index
  // entries for a room nobody can reach.
  if (rooms.get(room.key) !== room) return;
  if (hasTargets(targets)) registerTargets(room, targets);
  await processRoom(room, heardAt);
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
  // A discovered room's files come and go inside its dirs: the tree watch is
  // what hears them. A fixed room's are named — follow them.
  followRoom(room, room.discovered ? [] : targets.paths);
  for (const key of watchKeys) {
    let set = watchIndex.get(key);
    if (!set) {
      set = new Set();
      watchIndex.set(key, set);
    }
    set.add(room.key);
  }
}

async function processRoom(room: Room, heardAt?: number): Promise<void> {
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
    const { signature, changedAt } = await transcriptChainState(room.paths);
    if (signature === room.lastSignature) return;
    const seed = room.lastSignature === "";
    const value = await room.spec.read(
      room.paths,
      seed ? undefined : room.lastValue,
    );
    // Assigned together, AFTER a successful read. The old code stored the mtimes
    // before reading, so a transient read failure permanently dropped those events
    // until the next mtime change.
    // A write moves the newest mtime past the last read's; a signature that
    // moved otherwise (a re-resolved chain, a file gone) carries no write
    // time — its newest mtime may be hours old — so it says none.
    const wrote =
      !seed &&
      changedAt !== undefined &&
      (room.lastChangedAt === undefined || changedAt > room.lastChangedAt);
    room.lastValue = value;
    room.lastSignature = signature;
    room.lastChangedAt = changedAt;
    fanOut(room, {
      value,
      signature,
      ...(wrote ? { changedAt } : {}),
      // Paired with the write it heard: a read that found a write newer than
      // any hearing had no watch delay for it.
      ...(wrote && heardAt !== undefined && heardAt >= changedAt
        ? { heardAt }
        : {}),
    });
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
  for (const key of room.watchKeys) {
    const set = watchIndex.get(key);
    if (!set) continue;
    set.delete(room.key);
    if (set.size === 0) watchIndex.delete(key);
  }
  rooms.delete(room.key);
  followRoom(room, []);
}

/**
 * Point a room's kqueue follow at `paths` (none: stop it). Runs after every
 * earlier (re)start of the room's follow; the new follow opens before the old
 * one stops, so no write between them goes unheard. A follow that fails to
 * open is reported — the room still hears its files through the tree watch,
 * only later.
 */
function followRoom(room: Room, paths: readonly string[]): void {
  if (sameFiles(room.followed, paths)) return;
  const files = [...paths];
  room.followed = files;
  room.following = room.following.then(async () => {
    // Superseded while queued: a later call holds the room's files now.
    if (room.followed !== files) return;
    const previous = room.follow;
    let opened: FileWatcher | null = null;
    if (files.length > 0 && rooms.get(room.key) === room) {
      const step = await reportingFollowFailure(room, "open", () =>
        transcriptFollowsWatcher.start({
          files,
          label: room.key,
          onChange: () =>
            roomRuns.trigger(room, [{ kind: "read", heardAt: Date.now() }]),
        }),
      );
      if (step.ok) opened = step.value;
    }
    room.follow = opened;
    if (previous)
      await reportingFollowFailure(room, "close", () => previous.stop());
    // Closed (or re-pointed) while opening: the follow just opened is not wanted.
    if (opened !== null && room.followed !== files) {
      room.follow = null;
      await reportingFollowFailure(room, "close", () => opened.stop());
    }
  });
}

/**
 * Run one step of a room's follow, reporting a failure instead of rejecting:
 * a rejected step would end the room's chain, so no later re-point or close
 * of its follow would run. The room still hears its files through the tree
 * watch, only later.
 */
async function reportingFollowFailure<T>(
  room: Room,
  step: "open" | "close",
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    reportServerError({
      message: `[transcript-watcher] could not ${step} the kqueue follow of ${room.key}'s files: ${err instanceof Error ? err.message : String(err)}`,
      ...crashFieldsOf(err, "transcript-watcher.followed-files"),
    });
    return { ok: false };
  }
}

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
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
  /** When the files changed — absent on the first read (see `PathsSnapshot.changedAt`). */
  changedAt?: number;
  /** When a watch heard that change (see `PathsSnapshot.heardAt`). */
  heardAt?: number;
}

/**
 * The refresh group of everything derived from one conversation's session chain.
 *
 * A consumer that resolves its own files FROM that chain (the sub-agent index,
 * whose directories sit beside the chain's transcripts) declares this tag, so a
 * recorded session switch reaches it too — nothing else would re-resolve it.
 */
export function conversationChainTag(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** A transcript room's value: the chain read so far, and the events built from it. */
interface TranscriptRead {
  chain: ChainRead;
  events: JsonlEvent[];
}

/** Read a transcript room's files, continuing its previous read: an append costs the bytes appended. */
async function readTranscript(
  paths: readonly string[],
  previous: TranscriptRead | undefined,
): Promise<TranscriptRead> {
  const chain = await readChain(paths, previous?.chain);
  return { chain, events: await chain.lines.events() };
}

/** Watch a conversation's whole session chain, merged and parsed. */
export function watchTranscript(
  conversationId: string,
  onChange: (snapshot: TranscriptSnapshot) => void,
): () => void {
  return watchPaths<TranscriptRead>(
    {
      key: `transcript:${conversationId}`,
      refreshOn: conversationChainTag(conversationId),
      // Fixed membership: the session-chain table decides which files these are,
      // and it tells us through `refreshConversationChain`.
      resolve: async () => ({
        paths: await resolveConversationTranscriptPaths(conversationId),
      }),
      read: readTranscript,
    },
    ({ value, signature, changedAt, heardAt }) =>
      onChange({
        events: value.events,
        signature,
        ...(changedAt === undefined ? {} : { changedAt }),
        ...(heardAt === undefined ? {} : { heardAt }),
      }),
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
  return watchPaths<TranscriptRead>(
    {
      key: `file:${path}`,
      resolve: () => Promise.resolve({ paths: [path] }),
      read: readTranscript,
    },
    ({ value, signature, changedAt, heardAt }) =>
      onChange({
        events: value.events,
        signature,
        ...(changedAt === undefined ? {} : { changedAt }),
        ...(heardAt === undefined ? {} : { heardAt }),
      }),
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
