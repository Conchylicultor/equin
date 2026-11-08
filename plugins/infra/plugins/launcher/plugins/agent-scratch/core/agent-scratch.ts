/**
 * A temp directory every session on the machine shares, so a fixed name in it
 * (`/tmp/msg.txt`, `/tmp/tc.log`) is one file for every agent that types it.
 *
 * That is not hypothetical: on 2026-11-08 an agent wrote its push message to
 * `/tmp/msg.txt`, another session rewrote the same file before the push read
 * it, and the commit carried the other task's message. Over the 4 days before,
 * 225 of 546 sessions used a fixed `/tmp/<name>` and 62 names were used by two
 * sessions or more.
 *
 * `/private/…` is the same directory on macOS (`/tmp` is a symlink to
 * `/private/tmp`); {@link foreignTempPath} folds it before comparing.
 */
export const SHARED_TEMP_ROOTS: readonly string[] = ["/tmp", "/var/tmp"];

/**
 * The parent of every session's scratch directory. Under `/tmp` on purpose:
 * the OS reclaims it (reboot, and macOS's periodic sweep of entries idle for
 * three days), so a conversation that ends leaves nothing to collect. Short, so
 * a socket a tool opens inside it stays under the AF_UNIX path cap.
 */
export const SCRATCH_ROOT = "/tmp/equin-scratch";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The one scratch directory of a session: `<SCRATCH_ROOT>/<owner>`, where the
 * owner is the conversation id for an app-launched agent (stable across its
 * Claude sessions; the launcher creates the directory and hands it to the
 * shell as `EQUIN_SCRATCH`) and the Claude session id for a session no app
 * launched. Its subagents share it — they run in the same session, under the
 * one mind that names their files.
 *
 * Throws on an owner that is not one path segment: a `/` or `..` in it would
 * name a directory another session owns.
 */
export function agentScratchDir(owner: string): string {
  if (!OWNER.test(owner) || owner.includes(".."))
    throw new Error(
      `agentScratchDir: '${owner}' is not a session id (one path segment of [A-Za-z0-9._-])`,
    );
  return `${SCRATCH_ROOT}/${owner}`;
}

function foldPrivate(path: string): string {
  return path === "/private" || path.startsWith("/private/")
    ? path.slice("/private".length) || "/"
    : path;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** What is a session's own inside the shared temp roots. */
export interface OwnTemp {
  /** Its {@link agentScratchDir}. */
  scratchDir: string;
  /**
   * Its Claude Code session id. Claude Code keeps a directory per session —
   * `/tmp/claude-<uid>/<project slug>/<session id>/`, its background tasks'
   * output files and its scratchpad — which is as private as the scratch dir.
   */
  claudeSessionId: string;
}

const CLAUDE_SESSION_DIR = /^\/tmp\/claude-\d+\/[^/]+\/([^/]+)(?:\/|$)/;

/**
 * `path` (absolute, already resolved) with `/private` folded off, when it names
 * something strictly INSIDE a shared temp root and outside what the session
 * owns ({@link OwnTemp}); `null` otherwise. The root itself (`ls /tmp`) names
 * no file.
 */
export function foreignTempPath(path: string, own: OwnTemp): string | null {
  const p = foldPrivate(path);
  if (within(p, foldPrivate(own.scratchDir))) return null;
  if (CLAUDE_SESSION_DIR.exec(p)?.[1] === own.claudeSessionId) return null;
  return SHARED_TEMP_ROOTS.some((root) => p.startsWith(`${root}/`)) ? p : null;
}
