import { opendirSync, realpathSync } from "node:fs";
import { getConfig } from "@plugins/config_v2/server";
import { midiFoldersConfig } from "../../shared/config";
import type { FolderStatus } from "../../shared/status";

/**
 * Probe one configured folder: resolve it (the OS watcher reports canonical
 * paths — on macOS `/tmp/x` is `/private/tmp/x` — so the canonical path is the
 * one idempotency key for the watcher, the corpus walk and the songs), then
 * open it, which is what a denied folder refuses even when it resolves
 * (`~/Downloads` without macOS's Files & Folders grant).
 *
 * Every errno becomes a state the library shows — none is skipped and none is
 * swallowed. A throw that is not an errno is a bug and propagates.
 */
export function probeFolder(path: string): FolderStatus {
  let dir: string;
  try {
    dir = realpathSync(path);
  } catch (err) {
    return failed(path, path, err, "resolve");
  }
  try {
    opendirSync(dir).closeSync();
  } catch (err) {
    return failed(path, dir, err, "open");
  }
  return { state: "ok", path, dir };
}

function failed(
  path: string,
  dir: string,
  err: unknown,
  step: "resolve" | "open",
): FolderStatus {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (!(err instanceof Error) || typeof code !== "string") throw err;
  switch (code) {
    case "ENOENT":
      return { state: "missing", path, dir };
    case "ENOTDIR":
      // Resolving fails with ENOTDIR when a component ABOVE the folder is a
      // file (nothing at the path); opening fails with it when the path
      // itself is a file.
      return step === "open"
        ? { state: "not-a-folder", path, dir }
        : { state: "missing", path, dir };
    case "EPERM":
    case "EACCES":
      return { state: "denied", path, dir, code };
    default:
      return { state: "unreadable", path, dir, code, message: err.message };
  }
}

// The last probe, in config order — `null` until the first one ran.
let statuses: FolderStatus[] | null = null;
const listeners = new Set<() => void>();

/**
 * Probe every configured folder again, publish the result when it differs
 * from the last one, and answer it. Called on every config change, at the
 * start of every reconcile and by the user's Check again.
 */
export function refreshFolderStatuses(): FolderStatus[] {
  const next = getConfig(midiFoldersConfig).folders.map((f) =>
    probeFolder(f.path),
  );
  const changed =
    statuses === null || JSON.stringify(statuses) !== JSON.stringify(next);
  statuses = next;
  if (changed) for (const listener of listeners) listener();
  return next;
}

/** The last probe (probing now if none ran yet). */
export function folderStatuses(): FolderStatus[] {
  return statuses ?? refreshFolderStatuses();
}

/** Called after every probe whose result changed; returns the unsubscribe. */
export function onFolderStatusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The folders the backend watches and walks: the readable ones, by their
 * real path. An unreadable folder is not in it — it is shown, not walked —
 * so one bad folder can neither abort the corpus walk nor fail the watcher
 * for the others, and its songs are never marked missing (their files are not
 * known to be gone, only unreadable).
 *
 * Sync because `defineCorpusIndex`'s `roots` is a synchronous
 * `() => string[]`, read fresh on every walk.
 */
export function readableDirs(): string[] {
  return folderStatuses()
    .filter((s) => s.state === "ok")
    .map((s) => s.dir);
}
