import type * as parcel from "@parcel/watcher";

// The process's FSEvents streams, shared: one per watched root, however many
// watches — of any declaration, at either depth — want a dir inside it.
//
// Every stream is work fseventsd does for every file event on the machine (it
// matches the event against each client's paths), and every open or close is a
// synchronous RPC to it (`FSEventStreamStart` / `Stop`: 0.05 s idle, over a
// second loaded, and 20–30 s while it is stuck at one full core — measured
// 2026-11-09). parcel already shares one stream between subscriptions of the
// same dir with the same ignore; it does not see that a watch of `/a/b` is
// covered by an open stream of `/a`. This pool does:
//
// - A watch whose dir is at or below an open (or opening) recursive stream
//   rides it, its events filtered here: a `children` watch to the dir's direct
//   entries, a `subtree` one to everything below it. Joining a started stream
//   is live at once — the stream already hears everything below its root — so
//   the engine's "live when it resolves" holds (`engine.test.ts`).
// - Otherwise it opens a stream of its own dir: recursive for `subtree`; for
//   `children` every deeper path ignored natively, which a second children
//   watch of the same dir joins (a recursive watch never rides one).
// - Riders are never moved. A stream opening above an open one does not take
//   its riders over: closing the lower stream would drop what fseventsd has
//   queued for it and not yet delivered (3–14 s at load), and nothing in
//   parcel's API says when that queue is empty. The lower stream closes when
//   its last rider leaves; later watches ride the covering one.
//
// Only streams with no native ignore are pooled: an ignore keeps paths out of
// the stream, so it cannot carry a watch that wants them. A watch with an
// ignore opens its own (the engine's `subscribeRoot`; parcel dedups identical
// ones), and FSEvents is the only backend this applies to.

/** One watch riding a pooled stream. */
export interface StreamRider {
  /** The watched dir as the caller spelled it. */
  dir: string;
  depth: "subtree" | "children";
  /**
   * Its events: a `subtree` rider's as FSEvents names them (real paths, its
   * dir itself included), a `children` rider's direct entries named under
   * `dir` (its own dir withheld). Never empty.
   */
  onEvents(events: parcel.Event[]): void;
  /** The stream reported an error (FSEvents dropped events). */
  onLost(error: Error): void;
  /**
   * Its dir went — removed, moved away, or replaced (its inode changed) —
   * or the stream's root did. Once; the rider is already off the stream.
   */
  onGone(): void;
}

/** What the pool reaches the filesystem through — the engine's (parcel, timed-fs). */
export interface StreamHost {
  /** Opens one native stream of a real dir. */
  open(
    real: string,
    callback: parcel.SubscribeCallback,
    options: { ignore: RegExp[] } | undefined,
  ): Promise<parcel.AsyncSubscription>;
  /** The dir's real path; rejects when it is missing. */
  realpath(path: string): Promise<string>;
  /** The path's inode, or null when it is not there (any other failure throws). */
  inodeOf(path: string): Promise<number | null>;
}

interface Stream {
  readonly real: string;
  readonly depth: "subtree" | "children";
  readonly key: string;
  readonly riders: Set<Ride>;
  native: Promise<parcel.AsyncSubscription> | null;
  closing: Promise<void> | null;
  ino: number;
}

interface Ride {
  readonly rider: StreamRider;
  readonly real: string;
  readonly ino: number;
  stream: Stream;
  off: boolean;
}

export interface StreamPool {
  /**
   * Hear `rider.dir` until the returned release runs. Resolves once the
   * stream it rides is started — a change after it is heard. Rejects when the
   * dir cannot be watched (missing), holding nothing.
   */
  ride(rider: StreamRider): Promise<() => Promise<void>>;
  /** The streams open (or opening) now, with how many watches ride each. */
  streams(): { root: string; depth: "subtree" | "children"; riders: number }[];
  /** Streams this pool has opened since it was created. */
  opened(): number;
}

const isAtOrUnder = (root: string, path: string): boolean =>
  path === root ||
  (root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`));

/** `path`'s ancestors, nearest first, ending at `/`. */
function* selfAndAncestors(path: string): Generator<string> {
  let p = path;
  for (;;) {
    yield p;
    if (p === "/") return;
    const i = p.lastIndexOf("/");
    p = i <= 0 ? "/" : p.slice(0, i);
  }
}

/** The inode of a dir that must be there: a missing one rejects. */
async function presentInode(host: StreamHost, path: string): Promise<number> {
  const ino = await host.inodeOf(path);
  if (ino === null) {
    throw Object.assign(new Error(`ENOENT: no such directory, ${path}`), {
      code: "ENOENT",
    });
  }
  return ino;
}

export function createStreamPool(host: StreamHost): StreamPool {
  const { open, inodeOf } = host;
  const streams = new Map<string, Stream>();
  let opened = 0;
  const keyOf = (depth: "subtree" | "children", real: string) =>
    `${depth}\0${real}`;

  /** The stream `real` rides: the nearest recursive one covering it, else a children one of it. */
  function hostFor(
    real: string,
    depth: "subtree" | "children",
  ): Stream | undefined {
    for (const p of selfAndAncestors(real)) {
      const s = streams.get(keyOf("subtree", p));
      if (s !== undefined) return s;
    }
    return depth === "children"
      ? streams.get(keyOf("children", real))
      : undefined;
  }

  function close(stream: Stream): Promise<void> {
    if (streams.get(stream.key) === stream) streams.delete(stream.key);
    const native = stream.native;
    stream.closing ??=
      native === null ? Promise.resolve() : native.then((s) => s.unsubscribe());
    return stream.closing;
  }

  function leave(ride: Ride): Promise<void> {
    if (ride.off) return ride.stream.closing ?? Promise.resolve();
    ride.off = true;
    const { stream } = ride;
    stream.riders.delete(ride);
    return stream.riders.size === 0 ? close(stream) : Promise.resolve();
  }

  function gone(ride: Ride): void {
    if (ride.off) return;
    // Off the stream before the callback: a re-arm from it opens afresh.
    void leave(ride);
    ride.rider.onGone();
  }

  function deliver(stream: Stream, events: parcel.Event[]): void {
    for (const ride of [...stream.riders]) {
      if (ride.off) continue;
      const { rider, real } = ride;
      const mine: parcel.Event[] = [];
      for (const e of events) {
        if (rider.depth === "subtree") {
          if (isAtOrUnder(real, e.path)) mine.push(e);
        } else if (e.path.startsWith(real === "/" ? "/" : `${real}/`)) {
          const name = e.path.slice(real === "/" ? 1 : real.length + 1);
          if (name !== "" && !name.includes("/")) {
            mine.push({
              ...e,
              path: rider.dir.endsWith("/")
                ? `${rider.dir}${name}`
                : `${rider.dir}/${name}`,
            });
          }
        }
      }
      if (mine.length > 0) rider.onEvents(mine);
    }
  }

  /**
   * After a batch is delivered: did it name the stream's root, or a rider's dir
   * or one of its folders below the root? Then look — FSEvents replays a moment
   * from before a stream opened, so an earlier incarnation's delete may arrive:
   * only a missing path or another inode is a dir gone. A stat that fails for
   * any reason but absence rejects here, unhandled — loud, never swallowed.
   */
  function checkGone(stream: Stream, events: parcel.Event[]): void {
    const named = new Set(events.map((e) => e.path));
    if (named.has(stream.real)) {
      void inodeOf(stream.real).then(async (ino) => {
        if (ino === stream.ino || stream.closing !== null) return;
        // A stream whose root is gone deafens every other parcel stream of
        // the process while it stays open (measured, parcel 2.6.0): close it
        // at once, and every rider with it — they were all below it.
        const riders = [...stream.riders];
        await close(stream);
        for (const ride of riders) gone(ride);
      });
    }
    for (const ride of stream.riders) {
      if (ride.off || ride.real === stream.real) continue;
      let hit = false;
      for (const p of selfAndAncestors(ride.real)) {
        if (p === stream.real) break;
        if (named.has(p)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      void inodeOf(ride.real).then((ino) => {
        if (ino !== ride.ino) gone(ride);
      });
    }
  }

  function openStream(real: string, depth: "subtree" | "children"): Stream {
    const stream: Stream = {
      real,
      depth,
      key: keyOf(depth, real),
      riders: new Set(),
      native: null,
      closing: null,
      ino: 0,
    };
    streams.set(stream.key, stream);
    opened += 1;
    stream.native = (async () => {
      stream.ino = await presentInode(host, real);
      return open(
        real,
        (err, events) => {
          if (stream.closing !== null) return;
          deliver(stream, events);
          if (err)
            for (const ride of [...stream.riders]) ride.rider.onLost(err);
          checkGone(stream, events);
        },
        depth === "children" ? { ignore: [/\//] } : undefined,
      );
    })();
    return stream;
  }

  return {
    async ride(rider) {
      const real = await host.realpath(rider.dir);
      const ino = await presentInode(host, real);
      const stream =
        hostFor(real, rider.depth) ?? openStream(real, rider.depth);
      const ride: Ride = { rider, real, ino, stream, off: false };
      stream.riders.add(ride);
      try {
        await stream.native;
      } catch (err) {
        // A stream that failed to open is no host: every rider waiting on it
        // rejects with its error, holding nothing.
        ride.off = true;
        stream.riders.delete(ride);
        if (streams.get(stream.key) === stream) streams.delete(stream.key);
        throw err;
      }
      return () => leave(ride);
    },
    streams: () =>
      [...streams.values()].map((s) => ({
        root: s.real,
        depth: s.depth,
        riders: s.riders.size,
      })),
    opened: () => opened,
  };
}
