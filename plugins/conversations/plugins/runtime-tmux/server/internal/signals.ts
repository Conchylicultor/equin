import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RuntimeSignal } from "@plugins/conversations/server";
import {
  defineFileWatcher,
  type FileChangeEvent,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { CLAUDE_SESSIONS_DIR } from "@plugins/infra/plugins/paths/server";
import { opSignalsDir } from "@plugins/infra/plugins/worktree/data-dirs";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { tmuxSignalsDir } from "../../data-dirs";
import { routeSessionFile, type SessionFileRoute } from "./claude-session";
import { AGENT_SESSION_RE } from "./pane-rows";
import { installTmuxHooks } from "./tmux-hooks";

// The tmux runtime's push signals: three watched directories, each turning a
// file change into "these conversations' live state may have moved". They only
// ever WAKE the reconciler — `inspect()` re-reads the panes, the process tree
// and the sessions files, so a spurious, duplicate or late signal is harmless.
// What would be harmful is a missing one; the status sweep job is that backstop.

// A woken reconcile can land before the pane has drawn what woke it: the
// PreToolUse hook fires before the AskUserQuestion menu is painted (measured on
// CLI 2.1.287, an idle host: the menu showed in capture-pane ~380 ms after the
// hook). So every signal-dir touch is followed by exactly ONE re-check this much
// later — margin for a loaded host; a single follow-up, never a loop.
const REDRAW_RECHECK_MS = 1_000;

export const sessionFilesWatcher = defineFileWatcher({
  name: "runtime-tmux.session-files",
  description:
    "Watches Claude Code's per-process sessions files, which the CLI rewrites on every working/waiting transition, and reconciles the conversation whose tmux pane the changed file is stamped with.",
  extensions: [".json"],
  debounceMs: 150,
});

export const tmuxSignalsWatcher = defineFileWatcher({
  name: "runtime-tmux.tmux-signals",
  description:
    "Watches the tmux signal directory, touched by the global tmux hooks when an agent session is created or closed and by each agent's Claude Code hooks when a question menu opens or closes, and reconciles the named conversation.",
  debounceMs: 50,
});

export const opSignalsWatcher = defineFileWatcher({
  name: "runtime-tmux.op-signals",
  description:
    "Watches the worktree op-signal directory, where a file named after a worktree is touched whenever one of its build / push op markers is published, released or reaped, so an agent idling at its prompt while an op runs reads as working and flips back to waiting the moment the op ends.",
  debounceMs: 150,
});

/** `<pid>.json` → pid, or null for any other file name. */
function pidOf(path: string): number | null {
  const match = /^(\d+)\.json$/.exec(basename(path));
  return match ? Number(match[1]) : null;
}

/**
 * The worktrees an op-signal batch names: one file per worktree slug, touched
 * when its op markers change. Deletions are the prune job, not a signal.
 */
export function opSignalSlugs(events: readonly FileChangeEvent[]): string[] {
  const slugs = new Set<string>();
  for (const event of events) {
    if (event.type !== "delete") slugs.add(basename(event.path));
  }
  return [...slugs];
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** One sessions file's route, or null when it no longer exists. */
async function readRoute(path: string): Promise<SessionFileRoute | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return routeSessionFile(raw, path);
}

/** The signal a route stands for, or null when it names none of ours. */
function signalOf(route: SessionFileRoute): RuntimeSignal | null {
  switch (route.kind) {
    case "session":
      return AGENT_SESSION_RE.test(route.sessionName)
        ? { conversationIds: [route.sessionName] }
        : null;
    case "cwd":
      return { worktreeName: basename(route.cwd) };
    case "none":
      return null;
  }
}

let subscribed = false;

/**
 * Arm the tmux hooks and open the three watchers, delivering every signal to
 * `onSignal`. Rejects when any source cannot open. One subscriber per process.
 */
export async function subscribeTmuxSignals(
  onSignal: (signal: RuntimeSignal) => void,
): Promise<() => void> {
  if (subscribed) {
    throw new Error("runtime-tmux signals: already subscribed in this process");
  }
  subscribed = true;

  await installTmuxHooks();

  // pid → the route its sessions file named when last read, so the file's
  // DELETION — a normal Claude exit removes it — still names the conversation.
  // Seeded from every file present now; bounded by the live session files.
  const routes = new Map<number, SessionFileRoute>();
  mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
  for (const name of await readdir(CLAUDE_SESSIONS_DIR)) {
    const pid = pidOf(name);
    if (pid === null) continue;
    const route = await readRoute(join(CLAUDE_SESSIONS_DIR, name));
    if (route) routes.set(pid, route);
  }

  async function onSessionFiles(events: FileChangeEvent[]): Promise<void> {
    for (const event of events) {
      const pid = pidOf(event.path);
      if (pid === null) continue;
      let route: SessionFileRoute | null;
      try {
        route = event.type === "delete" ? null : await readRoute(event.path);
      } catch (err) {
        // A read racing the CLI's own write sees half a file. The write that
        // completes it may already be folded into this batch, so dropping it
        // could lose the transition: fall back to the last route this pid named,
        // and when there is none, to everything. Any other error is real.
        if (!(err instanceof SyntaxError)) throw err;
        const known = routes.get(pid);
        onSignal(known ? (signalOf(known) ?? { all: true }) : { all: true });
        continue;
      }
      if (route) {
        routes.set(pid, route);
      } else {
        // Gone: name it by what it last said. A pid never seen here was created
        // and removed within one batch by a session no conversation is tracking
        // yet; the sweep covers whatever that could have been.
        route = routes.get(pid) ?? null;
        routes.delete(pid);
        if (!route) continue;
      }
      const signal = signalOf(route);
      if (signal) onSignal(signal);
    }
  }

  const pendingRechecks = new Set<ReturnType<typeof setTimeout>>();
  function onSignalFiles(events: FileChangeEvent[]): void {
    const ids = new Set<string>();
    for (const event of events) {
      // The sweep's prune deletes old files; a deletion is not a signal.
      if (event.type === "delete") continue;
      const name = basename(event.path);
      if (AGENT_SESSION_RE.test(name)) ids.add(name);
    }
    if (ids.size === 0) return;
    const conversationIds = [...ids];
    onSignal({ conversationIds });
    const recheck = setTimeout(() => {
      pendingRechecks.delete(recheck);
      void runTracked("runtime-tmux:redraw-recheck", async () => {
        onSignal({ conversationIds });
      });
    }, REDRAW_RECHECK_MS);
    pendingRechecks.add(recheck);
  }

  function onOpSignals(events: FileChangeEvent[]): void {
    for (const worktreeName of opSignalSlugs(events))
      onSignal({ worktreeName });
  }

  const watchers: FileWatcher[] = [];
  try {
    watchers.push(
      await sessionFilesWatcher.start({
        dirs: [CLAUDE_SESSIONS_DIR],
        onChange: (events) =>
          runTracked("runtime-tmux:session-files", () =>
            onSessionFiles(events),
          ),
      }),
      await tmuxSignalsWatcher.start({
        dirs: [tmuxSignalsDir.ensure()],
        onChange: onSignalFiles,
      }),
      await opSignalsWatcher.start({
        dirs: [opSignalsDir.ensure()],
        onChange: onOpSignals,
      }),
    );
  } catch (err) {
    await Promise.all(watchers.map((w) => w.stop()));
    subscribed = false;
    throw err;
  }

  return () => {
    for (const t of pendingRechecks) clearTimeout(t);
    pendingRechecks.clear();
    subscribed = false;
    void runTracked("runtime-tmux:signals-stop", () =>
      Promise.all(watchers.map((w) => w.stop())),
    );
  };
}
