import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  defineFileWatcher,
  WatchedDirGoneError,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { readPidFile, type PidFileRead } from "./registry";

/**
 * The pid files a backend follows. A follow of the named file, not a watch
 * of its folder: on darwin that is kqueue, which the kernel signals on the
 * write itself — live once `start` resolves, and as fast under host load as
 * when idle. A folder watch rides FSEvents, delivered by `fseventsd` in
 * bursts: measured 2026-11-08 at load average 20–30, writes reached a
 * long-open watch 0.1–3.4 s late (13 s on a parcel FSEvents stream) — so
 * an exit the follower should push arrived seconds late, however live the
 * watch itself was.
 * One descriptor per followed pid file, plus one per folder they sit in.
 */
export const pidFileWatcher = defineFileWatcher({
  name: "daemon.pid-files",
  description:
    "Follows the pid file of each detached or attached daemon (the gateway, a detached agent, a browser host), so the daemon reads as running, restarted or exited the moment its pid file is written or removed.",
  // Named-file follow (kqueue on darwin) — see above; not about writes to an
  // open file, which a pid file never has.
  writesWhileOpen: true,
  // Reads are already one at a time, folded (`reads` below): no batching.
  debounceMs: 0,
});

/**
 * One read of the pid file, numbered by when it STARTED: a read numbered
 * above a moment's {@link HeldPidFile.issued} began after that moment, so it
 * sees everything written before it.
 */
export interface HeldRead {
  read: PidFileRead;
  seq: number;
}

/** A pid file, watched: its last read held in memory. */
export interface HeldPidFile {
  /** The last read, or `null` before the first one landed (not known yet). */
  current(): HeldRead | null;
  /** The number of the last read started so far (0: none yet). */
  issued(): number;
  /**
   * Read the file again, off the thread, and hand it to `onRead` — for a
   * moment the file may have moved that no watch event covers (a bootstrap
   * just exited, a get found the process gone). Re-opens the watch first if
   * it is not open. Reads run one at a time; asks landing mid-read fold into
   * one read after it.
   */
  refresh(): void;
  /** Stop watching; no `onRead` after this. */
  release(): void;
}

/** No folder to follow: missing, or it went while the follow was opening. */
function isMissing(err: unknown): boolean {
  if (err instanceof WatchedDirGoneError) return true;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Follow `pidFile` and push each read of it to `onRead` (also held, for
 * `current()`): a follow of the file ({@link pidFileWatcher}), then a read,
 * then one read per change of it. Nothing is read on the caller's thread and
 * nothing polls.
 *
 * The follow is live once it opens, but it is still not the authority: every
 * follow of one folder shares one subscription, re-opened when a follower
 * joins or leaves, and a removal landing in that re-open is heard by nobody
 * (`infra/file-watcher`, follow-files). So the follower also asks for a read
 * ({@link HeldPidFile.refresh}) whenever a get finds nothing alive — a missed
 * change is caught by the next look.
 *
 * The folder is never created here: while it is missing (a launch's folder
 * the process makes later, a data root removed) there is no follow, the read
 * says `absent`, and the next refresh tries to open it again. The folder
 * going (or the follow losing events) drops the follow the same way. Any
 * other failure to open it is reported (`reportServerError`) and retried on
 * the next refresh; the read still runs.
 */
export function holdPidFile(
  pidFile: AppPath,
  onRead: (held: HeldRead) => void,
): HeldPidFile {
  let held: HeldRead | null = null;
  let issued = 0;
  let released = false;
  let watch: FileWatcher | null = null;

  const dropWatch = (): void => {
    const w = watch;
    watch = null;
    // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- closing one kqueue subscription: a syscall, no main-thread work; a rejection stays loud (unhandled).
    if (w !== null) void w.stop();
  };

  /** Open the follow; `false` while the folder is not there. */
  const arm = async (): Promise<boolean> => {
    let w: FileWatcher;
    // Lost before `watch` holds it (it lands mid-open): dropped once it does.
    let lostEarly = false;
    try {
      w = await pidFileWatcher.start({
        files: [pidFile],
        label: pidFile,
        onChange: () => reads.trigger(),
        // Events may have been dropped, or the folder went (its follow is
        // closed then): the file may have moved unheard. Open a new follow
        // on the next read, if a folder is back by then.
        onLost: () => {
          if (watch === w) dropWatch();
          else lostEarly = true;
          reads.trigger();
        },
      });
    } catch (err) {
      // No folder (yet, or any more): no follow.
      if (isMissing(err)) return false;
      throw err;
    }
    watch = w;
    if (released || lostEarly) dropWatch();
    return true;
  };

  const reads = createCoalescer({
    run: async () => {
      if (released) return;
      if (watch === null) {
        try {
          await arm();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportServerError({
            message: `[daemon] could not watch the pid file ${pidFile}; it is read only when asked until a refresh opens the watch: ${error.message}`,
            ...crashFieldsOf(error),
          });
        }
      }
      if (released) return;
      issued += 1;
      const seq = issued;
      const read = await readPidFile(pidFile);
      if (released) return;
      held = { read, seq };
      onRead(held);
    },
  });
  reads.trigger();

  return {
    current: () => held,
    issued: () => issued,
    refresh: () => reads.trigger(),
    release() {
      released = true;
      dropWatch();
    },
  };
}
