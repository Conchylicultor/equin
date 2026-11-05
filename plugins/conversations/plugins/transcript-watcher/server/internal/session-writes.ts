import { basename, dirname, relative, sep } from "node:path";
import type { FileChangeEvent } from "@plugins/infra/plugins/file-watcher/server";

// "A session's transcript was written" as a broadcast, fed by the one projects-
// dir subscription (watcher.ts) BEFORE room dispatch — so a transcript nobody
// has a room for yet (a session id not yet recorded anywhere) still reaches a
// listener. The status reconciler is why: it may only adopt a session id once
// that id's transcript exists, and the CLI creates the file a moment AFTER the
// sessions-file write that woke it — so it waits for this.

type Listener = (sessionIds: ReadonlySet<string>) => void;
/** The written session transcripts: session id → its file. */
type SessionListener = (written: ReadonlyMap<string, string>) => void;

const listeners = new Set<SessionListener>();
const ownerListeners = new Set<Listener>();

/** A top-level session transcript is `<projects>/<dir>/<uuid>.jsonl`. */
const SESSION_FILE_RE = /^([0-9a-f-]{36})\.jsonl$/;
const SESSION_ID_RE = /^[0-9a-f-]{36}$/;

/**
 * The top-level session transcripts a batch created or appended to, by session
 * id — with the file, so a listener can see WHERE a session was written (the
 * status reconciler checks it is the projects dir it expected). Sub-agent files
 * sit deeper (`<dir>/<session>/subagents/…`) and are not sessions. Creates and
 * updates are both counted: FSEvents may coalesce a file's birth with its first
 * write into one `update`, and a listener filters by the ids it is waiting on
 * anyway.
 */
export function writtenSessions(
  events: readonly FileChangeEvent[],
  projectsDir: string,
): Map<string, string> {
  const written = new Map<string, string>();
  for (const event of events) {
    if (event.type === "delete") continue;
    if (dirname(dirname(event.path)) !== projectsDir) continue;
    const match = SESSION_FILE_RE.exec(basename(event.path));
    if (match) written.set(match[1]!, event.path);
  }
  return written;
}

/**
 * The session ids that OWN a transcript a batch created or appended to: the
 * session itself for a top-level `<dir>/<uuid>.jsonl`, and the parent session
 * for a sub-agent's `<dir>/<uuid>/subagents/…/agent-<id>.jsonl` (workflow
 * agents included, one level deeper under `workflows/wf_<run>/`).
 */
export function writtenOwnerSessionIds(
  events: readonly FileChangeEvent[],
  projectsDir: string,
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "delete") continue;
    const parts = relative(projectsDir, event.path).split(sep);
    if (parts[0] === "..") continue; // outside the projects dir
    if (parts.length === 2) {
      const match = SESSION_FILE_RE.exec(parts[1]!);
      if (match) ids.add(match[1]!);
    } else if (
      parts.length >= 4 &&
      parts[2] === "subagents" &&
      SESSION_ID_RE.test(parts[1]!) &&
      parts.at(-1)!.startsWith("agent-")
    ) {
      ids.add(parts[1]!);
    }
  }
  return ids;
}

/**
 * Hear about every session transcript written on this host, as the session
 * ids each watcher batch touched and the file each was written to
 * ({@link writtenSessions}). Called on the watcher's batch, so a listener must
 * be cheap (a map lookup) and must not throw. Returns the unsubscribe.
 */
export function onSessionTranscriptWritten(
  listener: SessionListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hear about every write to a session's transcript OR to one of its sub-agents'
 * transcripts, as the set of OWNING session ids each watcher batch touched
 * ({@link writtenOwnerSessionIds}). Same contract as
 * {@link onSessionTranscriptWritten}: cheap, must not throw. Returns the
 * unsubscribe.
 */
export function onTranscriptWritten(listener: Listener): () => void {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
}

/** Fan a watcher batch out to the listeners. */
export function notifySessionTranscriptWrites(
  events: readonly FileChangeEvent[],
  projectsDir: string,
): void {
  if (listeners.size > 0) {
    const written = writtenSessions(events, projectsDir);
    if (written.size > 0) for (const listener of listeners) listener(written);
  }
  if (ownerListeners.size > 0) {
    const ids = writtenOwnerSessionIds(events, projectsDir);
    if (ids.size > 0) for (const listener of ownerListeners) listener(ids);
  }
}
