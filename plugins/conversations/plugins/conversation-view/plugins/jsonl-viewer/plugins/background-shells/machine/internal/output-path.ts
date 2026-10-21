import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { SHELL_ID_PATTERN } from "../../core";

/** Where the output-path check looks: the tmp roots and the uid Claude Code keys its dir by. */
export interface ShellOutputPathContext {
  /** Absolute tmp roots, without a trailing slash. */
  roots: readonly string[];
  uid: number;
}

/**
 * The tmp roots Claude Code may write its shell output under on this machine.
 *
 * On macOS the transcript records `/private/tmp/claude-<uid>/…` — `/tmp` is a
 * symlink to `/private/tmp`, and Claude Code writes the resolved form — while
 * `os.tmpdir()` may read `/tmp` (or a `$TMPDIR` under `/var/folders`). Every
 * spelling of the tmp dir this process can see is accepted; nothing outside
 * them is.
 */
export function shellOutputPathContext(): ShellOutputPathContext {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error(
      "[background-shells] process.getuid() is unavailable; cannot validate a shell output path.",
    );
  }
  const candidates = ["/tmp", "/private/tmp", tmpdir(), realpathSync(tmpdir())];
  const roots = [...new Set(candidates.map((r) => r.replace(/\/+$/, "")))];
  return { roots, uid };
}

/**
 * Throw unless `path` is exactly where Claude Code writes background shell
 * `shellId`'s output: `<tmp root>/claude-<uid>/<cwd slug>/<session id>/tasks/<shellId>.output`.
 *
 * The path comes out of a transcript, which the agent itself writes into — so
 * it is checked here, at the one place the server turns it into a file read,
 * rather than trusted. A path that does not have the shape is a loud failure,
 * never a silently-served file.
 */
export function assertShellOutputPath(
  path: string,
  shellId: string,
  ctx: ShellOutputPathContext,
): void {
  const fail = (why: string): never => {
    throw new Error(
      `[background-shells] refusing output path for shell ${JSON.stringify(shellId)}: ${why} (${JSON.stringify(path)})`,
    );
  };
  if (!SHELL_ID_PATTERN.test(shellId)) fail("malformed shell id");
  const root = ctx.roots.find((r) => path.startsWith(`${r}/`));
  if (root === undefined) fail("not under a tmp root");
  const parts = path.slice(root!.length + 1).split("/");
  if (parts.length !== 5) fail("wrong depth");
  const [owner, slug, session, tasks, file] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (owner !== `claude-${ctx.uid}`) fail("not this user's claude dir");
  for (const segment of [slug, session]) {
    if (segment === "" || segment === "." || segment === "..") {
      fail("bad path segment");
    }
  }
  if (tasks !== "tasks") fail("not a tasks dir");
  if (file !== `${shellId}.output`) fail("file is not this shell's output");
}
