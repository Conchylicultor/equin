import type * as parcel from "@parcel/watcher";

// A `children` watch on macOS, heard by kqueue: one descriptor on the dir and
// one on each of its entries (parcel's kqueue backend, every deeper path
// ignored natively), never an FSEvents stream.
//
// Why not the FSEvents pool, which every other watch with no ignore rides: an
// FSEvents stream is delivered every event under its path, however deep. A
// children watch of `/` or `~` (the file explorer's) therefore made fseventsd
// match and deliver every file event on the machine to this process — the
// largest per-stream cost equin put on it — to hear a few dozen entries. And
// FSEvents is fseventsd's queue: 3–14 s late while it is loaded (2026-11-09),
// where kqueue delivers in milliseconds. kqueue costs what the dir holds, not
// what happens below it, so it fits exactly the watch that wants only the
// entries.
//
// What it costs is descriptors, one per entry, so it is bounded:
//
// - A dir holding more than KQUEUE_CHILDREN_OPEN_BUDGET entries at open, or
//   one that would take the process past KQUEUE_CHILDREN_PROCESS_BUDGET, rides
//   the FSEvents pool instead (`fallback`).
// - A dir that grows past KQUEUE_CHILDREN_CAP while watched moves to the pool:
//   the pool ride opens first, then the kqueue subscription closes, then the
//   dir is listed and diffed against the names the watch knew — a new name a
//   `create`, a gone one a `delete`, every other an `update` (a look). The
//   listing is not optional: parcel debounces what kqueue reported before it
//   delivers, so closing the subscription drops a batch it had not handed
//   over yet, and the FSEvents stream, started "since now", never reports
//   those changes (measured: 27 of 1,075 creates lost to a close without it).
//   A change around the move may be heard twice; none is lost.
//
// An entry this account may not open (macOS privacy protection: ~/.Trash
// without Full Disk Access) is listed but holds no descriptor — the patched
// addon keeps it (`parcel-addon`): its coming and going is heard, its writes
// are not.

// The three bounds are design bounds, chosen from measurements
// (`scripts/measure-kqueue-children.ts --sizes`, 2026-11-09), not limits
// raised until something passed. kqueue costs one descriptor per entry plus an
// open that lists the dir and each entry folder (256 entries: 6.5 ms, 1,024:
// 48 ms with a 216 ms tail, 4,096: 218 ms / 491 ms); FSEvents costs fseventsd's
// work per event below the dir. The dirs whose subtrees carry the machine's
// traffic — `/` (23 entries), `~` (57), the host status dirs (under 10) — are
// small; the dirs holding hundreds or thousands of entries are leaf content
// (Downloads, a runs dir), whose subtree traffic is their own, so FSEvents is
// cheap there and kqueue is not.

/** Entries a dir may hold at open to be watched on kqueue (open ≈ 6.5 ms, 257 descriptors at most). */
export const KQUEUE_CHILDREN_OPEN_BUDGET = 256;
/**
 * Entries a kqueue children watch may grow to before it moves to FSEvents:
 * 4× the open budget, so a dir near it does not flip between backends, and
 * well under the ~4,400 descriptors of one watch that crash-looped main on
 * 2026-11-05.
 */
export const KQUEUE_CHILDREN_CAP = 1024;
/**
 * Descriptors every kqueue children watch of the process may hold together.
 * Main held 240 descriptors in all on 2026-11-09, against a per-process limit
 * of 245,760 and 491,520 for the machine: with ~20 backends on a machine,
 * every one at this bound would hold a third of the machine's limit.
 */
export const KQUEUE_CHILDREN_PROCESS_BUDGET = 8192;

/**
 * Every path deeper than a direct entry: a relative path holding a `/`.
 * Spelled apart from the FSEvents pool's `/\//` on purpose: parcel shares one
 * native Watcher per (dir, ignore) whatever the backend, so a kqueue and an
 * FSEvents subscription of one dir with the same ignore would be one watcher
 * attached to two backends — each hearing the other's events, and the first
 * unsubscribe leaving the other backend watching.
 */
export const KQUEUE_CHILDREN_IGNORE = /[/]/;

export interface ChildrenWatchOn {
  /** Direct entries, named under the dir as the caller spelled it. */
  take: (events: parcel.Event[]) => void;
  /** Direct entries the watch made up (a listing diffed on a move): never timed as a delivery. */
  look: (events: parcel.Event[]) => void;
  /** The native watch reported an error: events may have been dropped. */
  lost: (error: Error) => void;
  /** The dir went (removed, moved away, replaced). Once; the watch is closed. */
  gone: () => void;
}

/** What a kqueue children watch reaches the filesystem through. */
export interface ChildrenHost {
  realpath(path: string): Promise<string>;
  /** The path's inode, or null when it is not there (any other failure throws). */
  inodeOf(path: string): Promise<number | null>;
  /**
   * The names of the dir's entries now, or null when this account may not
   * list it (kqueue needs the listing; FSEvents does not).
   */
  listEntries(real: string): Promise<string[] | null>;
  /** Opens one kqueue subscription of `real`, deeper paths ignored. */
  openKqueue(
    real: string,
    callback: parcel.SubscribeCallback,
  ): Promise<parcel.AsyncSubscription>;
  /** The same watch on the FSEvents pool; resolves to its release. */
  fallback(dir: string, on: ChildrenWatchOn): Promise<() => Promise<void>>;
}

/** Descriptors the process's kqueue children watches hold (an estimate: entries + 1 each, kept as they grow). */
let reserved = 0;

/** What the process's kqueue children watches hold now (for tests and the measure script). */
export function kqueueChildrenReserved(): number {
  return reserved;
}

/**
 * Watch `dir`'s direct entries until the returned release runs: on kqueue
 * when the dir is small enough (see above), else on the FSEvents pool. Live
 * when it resolves — kqueue registers every descriptor before `subscribe`
 * resolves. Rejects when the dir is missing, holding nothing.
 */
export async function watchChildrenOnKqueue(
  dir: string,
  on: ChildrenWatchOn,
  host: ChildrenHost,
): Promise<() => Promise<void>> {
  const real = await host.realpath(dir);
  const ino = await host.inodeOf(real);
  if (ino === null) {
    throw Object.assign(new Error(`ENOENT: no such directory, ${dir}`), {
      code: "ENOENT",
    });
  }
  const atOpen = await host.listEntries(real);
  if (
    atOpen === null ||
    atOpen.length > KQUEUE_CHILDREN_OPEN_BUDGET ||
    reserved + atOpen.length + 1 > KQUEUE_CHILDREN_PROCESS_BUDGET
  ) {
    return host.fallback(dir, on);
  }

  // The names the watch knows: what the move's listing is diffed against.
  const names = new Set(atOpen);
  let held = names.size + 1;
  reserved += held;
  const unreserve = (): void => {
    reserved -= held;
    held = 0;
  };

  let closed = false;
  let stopped = false;
  let goneReported = false;
  let moving = false;
  let fsEventsRelease: (() => Promise<void>) | null = null;
  const prefix = real === "/" ? "/" : `${real}/`;
  const spelled = (name: string): string =>
    dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;

  const reportGone = (): void => {
    if (goneReported || stopped) return;
    goneReported = true;
    on.gone();
  };

  // One close of the kqueue subscription, shared by stop, gone and the move.
  let closing: Promise<void> | null = null;
  const closeKqueue = (): Promise<void> => {
    closed = true;
    unreserve();
    closing ??= native.then((sub) => sub.unsubscribe());
    return closing;
  };

  // Once the pool hears the dir, the kqueue subscription goes. A ride that
  // fails because the dir went is the dir gone; any other failure rejects,
  // unhandled — loud.
  const moveToFsEvents = async (): Promise<void> => {
    moving = true;
    let release: () => Promise<void>;
    try {
      release = await host.fallback(dir, {
        take: (events) => {
          if (!stopped) on.take(events);
        },
        look: (events) => {
          if (!stopped) on.look(events);
        },
        lost: (error) => {
          if (!stopped) on.lost(error);
        },
        gone: reportGone,
      });
    } catch (err) {
      if ((await host.inodeOf(real)) === ino) throw err;
      await closeKqueue();
      reportGone();
      return;
    }
    await closeKqueue();
    // Stopped while the ride opened: give it back at once.
    if (stopped) {
      await release();
      return;
    }
    fsEventsRelease = release;
    // What the closed subscription had not delivered yet: the listing, diffed.
    let now: string[] | null;
    try {
      now = await host.listEntries(real);
    } catch (err) {
      // The dir went meanwhile: that is the watch's news, not a failure.
      if ((await host.inodeOf(real)) === ino) throw err;
      reportGone();
      return;
    }
    if (stopped || goneReported) return;
    if (now === null) {
      on.lost(
        new Error(
          `[file-watcher] ${dir} could not be listed after moving to FSEvents`,
        ),
      );
      return;
    }
    const present = new Set(now);
    const look: parcel.Event[] = [];
    for (const name of present) {
      look.push({
        type: names.has(name) ? "update" : "create",
        path: spelled(name),
      });
    }
    for (const name of names) {
      if (!present.has(name))
        look.push({ type: "delete", path: spelled(name) });
    }
    if (look.length > 0) on.look(look);
  };

  const native = host.openKqueue(real, (err, events) => {
    if (closed) return;
    const mine: parcel.Event[] = [];
    let ownNamed = false;
    for (const e of events) {
      if (e.path === real) {
        ownNamed = true;
        continue;
      }
      if (!e.path.startsWith(prefix)) continue;
      const name = e.path.slice(prefix.length);
      if (name === "" || name.includes("/")) continue;
      if (e.type === "create") names.add(name);
      else if (e.type === "delete") names.delete(name);
      mine.push({ ...e, path: spelled(name) });
    }
    // The process budget follows what the watch holds now, not at open.
    reserved += names.size + 1 - held;
    held = names.size + 1;
    if (mine.length > 0) on.take(mine);
    if (err) on.lost(err);
    if (ownNamed) {
      // The dir's own descriptor fired (deleted, renamed, attributes): look.
      // A stat that fails for any reason but absence rejects here, unhandled.
      void host.inodeOf(real).then(async (now) => {
        if (now === ino || closed) return;
        await closeKqueue();
        reportGone();
      });
      return;
    }
    if (!moving && names.size > KQUEUE_CHILDREN_CAP) void moveToFsEvents();
  });
  try {
    await native;
  } catch (err) {
    closed = true;
    unreserve();
    throw err;
  }

  return async () => {
    stopped = true;
    await closeKqueue();
    const release = fsEventsRelease;
    fsEventsRelease = null;
    await release?.();
  };
}
