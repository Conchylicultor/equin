import { fstatSync, openSync, readSync } from "node:fs";
import { adoptFd, type OwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { agentScratchDir } from "@plugins/infra/plugins/launcher/plugins/agent-scratch/core";
import { machineDeclaredRootEntriesSync } from "@plugins/infra/plugins/paths/core";
import { dataRootLayout } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import type { DataRootView } from "@plugins/infra/plugins/paths/core";
import { classifyRepo } from "./git-target";
import { worktreeContextOf } from "./worktree-root";
import type {
  AllowVerdict,
  DenyVerdict,
  GuardContext,
  InformVerdict,
  RewriteVerdict,
  TranscriptRead,
} from "./types";

/**
 * How much of the transcript's tail to read.
 *
 * Transcripts reach tens of MB in a long session and this runs inside a hook,
 * so the read is bounded rather than whole-file. The tail is the right end: a
 * guard asks about something that happened during its own window — at most the
 * last 30 minutes — which no session fills with 64 MB of output.
 */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024 * 1024;

function readTail(path: string): TranscriptRead {
  let fd: OwnedFd;
  try {
    fd = adoptFd(openSync(path, "r"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code == null) throw err;
    return { kind: "unavailable", why: `transcript unreadable (${code})` };
  }
  try {
    const size = fstatSync(fd.fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(length);
    readSync(fd.fd, buf, 0, length, size - length);
    return { kind: "read", text: buf.toString("utf8") };
  } finally {
    fd.close();
  }
}

/** The main checkout `checkout` is, or hangs off as a worktree. */
function mainCheckoutOf(checkout: string): string {
  return worktreeContextOf(checkout)?.repoRoot ?? checkout;
}

/**
 * A Claude session id as one path segment. A payload with an odd one still
 * gets a context — every guard runs on it — and a scratch dir that is merely
 * not unique, rather than a throw.
 */
const SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

let declaredRootEntries: ReadonlySet<string> | undefined;
let dataRootView: DataRootView | undefined;

/**
 * The data root as `data-root-writes` reads it: every spelling of the root
 * (the root, and the legacy name while it links to it), a disk probe, and the
 * machine's grandfathered root entries — read once per hook process, and only
 * when a write names a top-level entry that is neither a kind nor a shim.
 * Built on first read: a split install throws `DataRootSplitError` there, on
 * the one guard that reads a path, not on every hook call.
 */
function dataRootViewSync(): DataRootView {
  if (dataRootView) return dataRootView;
  const layout = dataRootLayout();
  dataRootView = {
    roots:
      layout.kind === "current" && layout.legacyLink
        ? [layout.root, layout.legacy]
        : [layout.root],
    existsSync,
    declaredRootEntriesSync: () =>
      (declaredRootEntries ??= machineDeclaredRootEntriesSync()),
  };
  return dataRootView;
}

export function createContext(
  cwd: string,
  sessionId = "unknown",
  writableDataDirs: readonly string[] = [],
  /**
   * `transcript_path` off the PreToolUse payload. Optional because a caller
   * that isn't the hook (a test, the transcript replay) has no session file —
   * absence surfaces as the `unavailable` arm, never as an empty transcript.
   */
  transcriptPath?: string,
  /**
   * The subagent this call came from, from the payload's `agent_id` /
   * `agent_type`. `null` means the main conversation — see `GuardContext.agent`.
   * Last and defaulted so the many `createContext(cwd)` calls in tests stay as
   * they are; a test that cares passes it.
   */
  agent: { id: string; type: string } | null = null,
  /** `tool_use_id` off the payload — see `GuardContext.toolUseId`. */
  toolUseId: string | null = null,
  /** The launch-named workspace root — see `GuardContext.workRoot`. */
  workspaceRoot: string | null = null,
  /** The launch-delivered `EQUIN_SCRATCH` — see `GuardContext.scratch`. */
  scratchDir: string | null = null,
): GuardContext {
  const workRoot = workspaceRoot ?? worktreeContextOf(cwd)?.worktreeRoot ?? cwd;
  return {
    cwd,
    workRoot,
    protectedRoot:
      worktreeContextOf(workRoot)?.repoRoot ??
      (workspaceRoot === null ? null : mainCheckoutOf(REPO_ROOT)),
    sessionId,
    writableDataDirs,
    agent,
    toolUseId,
    scratch:
      scratchDir === null
        ? {
            dir: agentScratchDir(
              SESSION_SEGMENT.test(sessionId) ? sessionId : "unknown",
            ),
            delivered: false,
          }
        : { dir: scratchDir, delivered: true },
    get dataRoot(): DataRootView {
      return dataRootViewSync();
    },
    readTranscript(): TranscriptRead {
      if (!transcriptPath)
        return {
          kind: "unavailable",
          why: "no transcript path in the payload",
        };
      return readTail(transcriptPath);
    },
    hasBypass(token: string): boolean {
      // At the checkout root, not the raw cwd: the hook's cwd follows the
      // session shell's persistent `cd`, so a file created at the root would
      // stop counting the moment the agent cd'd into a subdirectory.
      const repo = classifyRepo(cwd);
      const root = repo.kind === "not-a-repo" ? cwd : repo.root;
      return existsSync(join(root, token));
    },
    allow(): AllowVerdict {
      return { kind: "allow" };
    },
    deny(reason: string): DenyVerdict {
      return { kind: "deny", reason };
    },
    fatal(reason: string): DenyVerdict {
      return { kind: "deny", reason, fatal: true };
    },
    warn(reason: string): DenyVerdict {
      return { kind: "deny", reason, allowOnRepeat: true };
    },
    inform(context: string): InformVerdict {
      return { kind: "inform", context };
    },
    rewrite(
      patch: Readonly<Record<string, unknown>>,
      note: string | null,
    ): RewriteVerdict {
      return { kind: "rewrite", patch, note };
    },
  };
}
