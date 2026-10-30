import { opendir, realpath } from "node:fs/promises";
import { getConfig } from "@plugins/config_v2/server";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { midiFoldersConfig } from "../../shared/config";
import type { FolderStatus } from "../../shared/status";

/**
 * Probe one configured folder: resolve it (the OS watcher reports canonical
 * paths — on macOS `/tmp/x` is `/private/tmp/x` — so the canonical path is the
 * one idempotency key for the watcher, the corpus walk and the songs), then
 * open it, which is what a denied folder refuses even when it resolves
 * (`~/Downloads` without macOS's Files & Folders grant).
 *
 * Async on purpose, and it must stay so: while macOS's "allow access to this
 * folder?" prompt is up, the resolve blocks until someone answers it. A sync
 * call there froze main's JS thread for 5.5 h on 2026-10-11 — every span,
 * timer and request of the backend stood still until the user came back.
 * Async, the wait parks one thread-pool thread instead.
 *
 * Every errno becomes a state the library shows — none is skipped and none is
 * swallowed. A throw that is not an errno is a bug and propagates.
 */
export async function probeFolder(path: string): Promise<FolderStatus> {
  let dir: string;
  try {
    dir = await realpath(path);
  } catch (err) {
    return failed(path, path, err, "resolve");
  }
  try {
    await (await opendir(dir)).close();
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

/**
 * How long a refresh waits for the probes. A healthy folder answers in
 * milliseconds; one still unanswered after this is shown as `checking` (and
 * left out of the readable set) until its answer lands, so no caller — a
 * reconcile, the watcher's mount, a Check again — ever waits on a
 * permission prompt.
 */
export const PROBE_ANSWER_MS = 1_000;

export interface FolderStatusStore {
  /**
   * Probe every configured folder (a folder whose probe is still out joins
   * it), wait at most `answerWithinMs` for the answers, and answer the
   * statuses: a folder still unanswered by then reads `checking`. Each later
   * answer is published when it lands.
   */
  refresh(): Promise<FolderStatus[]>;
  /** The last statuses (the first refresh's, when none ran yet). */
  statuses(): Promise<FolderStatus[]>;
  /** The readable folders' real paths, as of the last published statuses. */
  readableDirs(): string[];
  /** Called after every publish that changed the statuses; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export function createFolderStatusStore(deps: {
  folders: () => string[];
  probe: (path: string) => Promise<FolderStatus>;
  answerWithinMs: number;
}): FolderStatusStore {
  // One probe per path at a time: a pending prompt holds one probe, however
  // many re-checks ask meanwhile.
  const probes = createInflight();
  // Each configured path's last answer.
  const answers = new Map<string, FolderStatus>();
  // The last published statuses, in config order — `null` until the first
  // refresh published.
  let published: FolderStatus[] | null = null;
  let first: Promise<FolderStatus[]> | null = null;
  const listeners = new Set<() => void>();

  const checking = (path: string): FolderStatus => ({
    state: "checking",
    path,
    dir: path,
  });

  function publish(): FolderStatus[] {
    const next = deps
      .folders()
      .map((path) => answers.get(path) ?? checking(path));
    const changed =
      published === null || JSON.stringify(published) !== JSON.stringify(next);
    published = next;
    if (changed) for (const listener of listeners) listener();
    return next;
  }

  async function refresh(): Promise<FolderStatus[]> {
    const paths = deps.folders();
    // A folder removed from the config forgets its answer, so re-adding it
    // reads `checking` until probed again, never a stale answer.
    for (const path of [...answers.keys()])
      if (!paths.includes(path)) answers.delete(path);
    const settled = new Set<string>();
    let late = false;
    const all = Promise.all(
      paths.map(async (path) => {
        const status = await probes.run(path, () => deps.probe(path));
        answers.set(path, status);
        settled.add(path);
        // An answer landing after the refresh returned publishes itself.
        if (late) publish();
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      all.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deps.answerWithinMs);
      }),
    ]);
    clearTimeout(timer);
    if (!answered) {
      late = true;
      // Not known yet is a state, never the last answer: a folder whose
      // probe is still out is not readable until it says so.
      for (const path of paths)
        if (!settled.has(path)) answers.set(path, checking(path));
      // The late probes outlive this refresh: their wait (and the publish
      // each answer makes) is a span of its own, and a late rejection — a
      // bug: a non-errno throw — surfaces as an unhandled rejection rather
      // than leaving the folder `checking` forever in silence (the race
      // above consumed `all`, so nothing else would see it).
      void runTracked("midi-folders:late-probe", () => all);
    }
    return publish();
  }

  return {
    refresh,
    statuses: () =>
      published !== null ? Promise.resolve(published) : (first ??= refresh()),
    readableDirs: () =>
      (published ?? []).filter((s) => s.state === "ok").map((s) => s.dir),
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const store = createFolderStatusStore({
  folders: () => getConfig(midiFoldersConfig).folders.map((f) => f.path),
  probe: probeFolder,
  answerWithinMs: PROBE_ANSWER_MS,
});

/**
 * Probe every configured folder again, publish the result when it differs
 * from the last one, and answer it — within {@link PROBE_ANSWER_MS}, a folder
 * still unanswered reading `checking`. Called on every config change, at the
 * start of every reconcile and by the user's Check again.
 */
export const refreshFolderStatuses = (): Promise<FolderStatus[]> =>
  store.refresh();

/** The last probe (probing now if none ran yet). */
export const folderStatuses = (): Promise<FolderStatus[]> => store.statuses();

/** Called after every probe whose result changed; returns the unsubscribe. */
export const onFolderStatusChange = (listener: () => void): (() => void) =>
  store.onChange(listener);

/**
 * The folders the backend watches and walks: the readable ones, by their
 * real path. An unreadable folder is not in it — it is shown, not walked —
 * so one bad folder can neither abort the corpus walk nor fail the watcher
 * for the others, and its songs are never marked missing (their files are not
 * known to be gone, only unreadable). A folder still `checking` is not in it
 * either: walking it would block on the same prompt the probe waits on.
 *
 * Sync because `defineCorpusIndex`'s `roots` is a synchronous
 * `() => string[]`, read fresh on every walk; every caller refreshes first.
 */
export const readableDirs = (): string[] => store.readableDirs();
