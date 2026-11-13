import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { flockTry } from "@plugins/packages/plugins/flock/server";
import {
  defineFileSink,
  readHistory,
} from "@plugins/infra/plugins/file-sink/core";
import {
  CpuHolderMarkerSchema,
  HolderPeakRecordSchema,
  type CpuHolderMarker,
  type HolderPeakRecord,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { cpuHoldersDir, holderPeaksLogDir } from "../../data-dirs";

// Who holds the `cpu` pool, and what each holder has been measured to use.
//
// The pool's slots are bare flock files: they say how many are held, never by
// whom, so a held slot could only be charged one fixed quantum. A holder now
// publishes a marker beside them for its share's life — its pid (the process
// tree it is measured on), its kind of work and its units — locked like an op
// marker (`infra/worktree`'s worktree-op): the kernel drops the lock when the
// holder dies, so a reader's successful try-lock means a dead holder, and no
// pid is ever trusted for liveness.

const TMP_SUFFIX = ".tmp";
// A temp file older than this was orphaned between create and rename.
const STALE_TMP_MS = 60_000;

let sequence = 0;

/** A published holder marker; `release()` unlinks it and drops its lock. */
export interface HeldCpuShare {
  release(): Promise<void>;
}

/**
 * Publish this process's holder marker for one share and lock it until
 * `release()` (or death). Written to a temp file, locked, then renamed into
 * place, so a reader only ever sees a complete, locked marker.
 */
export async function publishCpuHolder(
  marker: Omit<CpuHolderMarker, "v" | "pid">,
  dir: AppPath = cpuHoldersDir.path,
): Promise<HeldCpuShare> {
  await mkdir(dir, { recursive: true });
  const name = `${process.pid}-${sequence++}.json`;
  const path = joinAppPath(dir, name);
  const tmp = joinAppPath(dir, `${name}${TMP_SUFFIX}`);
  const handle = await open(tmp, "w");
  try {
    if (!flockTry(handle.fd))
      throw new Error(
        `host-admission: could not lock a holder marker this process just created (${tmp})`,
      );
    await handle.writeFile(
      JSON.stringify(
        CpuHolderMarkerSchema.parse({ v: 1, pid: process.pid, ...marker }),
      ),
    );
    await rename(tmp, path);
  } catch (err) {
    await handle.close();
    await rm(tmp, { force: true });
    throw err;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      // Unlink first, then close: a reader that opened it before the unlink
      // and locks it after the close only reaps an already-gone path. The
      // close runs even if the unlink throws, so the lock never outlives
      // the share in a long-lived process.
      try {
        await rm(path, { force: true });
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * Every live holder on the host: one readdir, one try-lock per marker. A
 * marker whose lock is free belongs to a holder that died — reaped here.
 *
 * A live marker this code cannot read — written by a CLI of another version
 * (a work this one does not know, another marker version) — is left out:
 * its slots are then charged as unrecorded, a whole quantum each, the
 * conservative side. Throwing would stop main's sampler on every tick for as
 * long as that holder lives, and with it the fleet reading admission runs on.
 */
export async function listCpuHolders(
  dir: AppPath = cpuHoldersDir.path,
): Promise<CpuHolderMarker[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found = await Promise.all(
    names.map(async (name): Promise<CpuHolderMarker | null> => {
      const path = joinAppPath(dir, name);
      if (name.endsWith(TMP_SUFFIX)) {
        await reapIfStaleTmp(path);
        return null;
      }
      return probeHolder(path);
    }),
  );
  return found.filter((m): m is CpuHolderMarker => m !== null);
}

async function probeHolder(path: AppPath): Promise<CpuHolderMarker | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let reap = false;
  try {
    // Taking the lock ⇒ the holder is gone. Held until the unlink below.
    if (flockTry(handle.fd)) {
      reap = true;
      return null;
    }
    // Renamed in whole, so the text is complete; whether this version can
    // read it is another matter (see `listCpuHolders`).
    const parsed = CpuHolderMarkerSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } finally {
    if (reap) await rm(path, { force: true });
    await handle.close();
  }
}

async function reapIfStaleTmp(path: AppPath): Promise<void> {
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs > STALE_TMP_MS) await rm(path, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

const PEAKS_FILE = holderPeaksLogDir.file("holder-peaks.jsonl");

// ~200 bytes a line: 2 MB × 3 files holds ~30k holders — weeks of this host's.
const MAX_LINES = 50_000;
const peaksSink = defineFileSink({
  id: "cpu-holder-peaks",
  description:
    "One JSONL line per finished cpu grant share on this host: its kind of work, units, lane and the largest footprint its process tree was read at — what each kind of work's memory reservation is derived from.",
  path: PEAKS_FILE,
  maxBytes: 2 * 1024 * 1024,
  keep: 2,
});

/** Append one finished holder's measurement to the ledger. */
export async function recordHolderPeak(
  record: HolderPeakRecord,
): Promise<void> {
  await peaksSink.append(JSON.stringify(HolderPeakRecordSchema.parse(record)));
}

/** The ledger as read: its records, and the lines it could not read. */
export interface HolderPeaks {
  /** Every readable record since the cut, oldest first. */
  records: HolderPeakRecord[];
  /**
   * Lines left out: torn (a crash mid-append, then a later append) or of a
   * shape this version does not read (another version's work). Said, never
   * thrown — a throw here would stop the fleet reading on every tick.
   */
  unreadable: number;
}

/** Every recorded holder since `sinceMs`, oldest first. */
export async function readHolderPeaks(sinceMs: number): Promise<HolderPeaks> {
  const lines = await readHistory(PEAKS_FILE, {
    before: null,
    notBefore: null,
    limit: MAX_LINES,
  });
  const records: HolderPeakRecord[] = [];
  let unreadable = 0;
  for (const { text } of lines) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      unreadable++;
      continue;
    }
    const r = HolderPeakRecordSchema.safeParse(json);
    if (!r.success) {
      unreadable++;
      continue;
    }
    if (Date.parse(r.data.t) >= sinceMs) records.push(r.data);
  }
  // `readHistory` reads newest first; a work's latest holders are its last.
  records.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { records, unreadable };
}
