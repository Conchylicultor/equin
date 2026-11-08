import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import {
  appPathParent,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { realpath } from "@plugins/packages/plugins/timed-fs/core";
import { readPidFile, type PidFileRead } from "./registry";

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

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Watch `pidFile` and push each read of it to `onRead` (also held, for
 * `current()`): a children-scope watch of its folder through the shared dir
 * hub, then a read, then one read per change of the entry. Nothing is read
 * on the caller's thread and nothing polls.
 *
 * The watch is live when the hub resolves it (`infra/file-watcher`), so the
 * read made after arming sees every write the watch does not hear. While
 * there is no watch (no folder yet, or it went or lost events), the follower
 * asks for a read ({@link HeldPidFile.refresh}) whenever a get finds nothing
 * alive — that read re-opens the watch.
 *
 * The folder is never created here: while it is missing (a launch's folder
 * the process makes later, a data root removed) there is no watch, the read
 * says `absent`, and the next refresh tries to open the watch again. The
 * folder going or the watch losing events drops the watch the same way. Any
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
  let watch: DirWatchRelease | null = null;

  const dropWatch = (): void => {
    const release = watch;
    watch = null;
    release?.();
  };

  /** Open the watch; `false` while the folder is not there. */
  const arm = async (): Promise<boolean> => {
    const parent = appPathParent(pidFile);
    let dir: string;
    try {
      // Events name paths as the filesystem reports them (no symlinked prefix).
      dir = await realpath(parent);
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
    const entry = `${dir}/${pidFile.slice(parent.length + 1)}`;
    let release: DirWatchRelease;
    try {
      release = await acquireDirWatch({
        dir,
        scope: "children",
        onChange: (events) => {
          if (events.some((e) => e.path === dir && e.type === "delete")) {
            // The folder went: the hub retires its watch. Open a new one on
            // the next read, if a folder is back by then.
            if (watch === release) dropWatch();
            reads.trigger();
          } else if (events.some((e) => e.path === entry)) reads.trigger();
        },
        // Events may have been dropped: the file may have moved unheard.
        onLost: () => {
          if (watch === release) dropWatch();
          reads.trigger();
        },
      });
    } catch (err) {
      // Gone between the realpath and the open: no folder, no watch yet.
      if (isMissing(err)) return false;
      throw err;
    }
    if (released) release();
    else watch = release;
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
            stack: error.stack,
            errorType: error.name,
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
