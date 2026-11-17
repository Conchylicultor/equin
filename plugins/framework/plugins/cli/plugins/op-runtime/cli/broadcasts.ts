import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { checkoutRef } from "@plugins/infra/plugins/paths/core";
import type { OpKind } from "@plugins/infra/plugins/worktree/core";

// Wedge-breaker for the local `git` metadata reads in this file — orders of
// magnitude above what any of them take, so only a wedged child trips it. A CLI
// process owns no deadline of its own, but that is a reason to bound these, not
// to leave them open: nothing else would ever break such a wedge (the
// fleet-level op-wedge watchdog was retired 2026-07-28).
const GIT_TIMEOUT_MS = 60_000;

type BroadcastCommand = OpKind;

interface Broadcast {
  since?: string;
  until?: string;
  severity: "error" | "warning" | "info";
  message: string;
  commands?: BroadcastCommand[];
}

async function gitOutput(args: string[]): Promise<string | null> {
  try {
    const result = await spawnCaptured(["git", ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "ENOENT" &&
      (err as NodeJS.ErrnoException).code !== "EACCES"
    )
      throw err;
    return null;
  }
}

async function isAncestor(
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    const result = await spawnCaptured(
      ["git", "merge-base", "--is-ancestor", ancestor, descendant],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    return result.exitCode === 0;
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "ENOENT" &&
      (err as NodeJS.ErrnoException).code !== "EACCES"
    )
      throw err;
    return false;
  }
}

const SEPARATOR =
  "════════════════════════════════════════════════════════════════════════════════";

function printBroadcast(entry: Broadcast): void {
  const tag = entry.severity.toUpperCase();
  const line = `BROADCAST [${tag}]: ${entry.message}`;
  const block = [SEPARATOR, line, SEPARATOR].join("\n");

  if (entry.severity === "error") {
    console.error(block);
  } else if (entry.severity === "warning") {
    console.warn(block);
  } else {
    console.log(block);
  }
}

export async function checkBroadcasts(
  command: BroadcastCommand,
): Promise<void> {
  const branch = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "main") return;
  // One of main's own checkouts — a main slot sits detached at one commit, so
  // its branch reads `HEAD` and only `checkoutRef` knows it is main.
  if ((await checkoutRef(await getWorktreeRoot())).kind === "main") return;

  const raw = await gitOutput([
    "show",
    "origin/main:plugins/framework/plugins/cli/broadcasts.json",
  ]);
  if (!raw) return;

  let entries: Broadcast[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    entries = parsed;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return;
  }

  const mergeBase = await gitOutput(["merge-base", "HEAD", "origin/main"]);
  if (!mergeBase) return;

  const matching: Broadcast[] = [];
  for (const entry of entries) {
    if (entry.commands && !entry.commands.includes(command)) continue;
    const sinceOk = entry.since
      ? await isAncestor(mergeBase, entry.since)
      : true;
    const untilOk = entry.until
      ? await isAncestor(mergeBase, entry.until)
      : true;
    if (sinceOk && untilOk) matching.push(entry);
  }

  if (matching.length === 0) return;

  console.log();
  for (const entry of matching) {
    printBroadcast(entry);
  }
  console.log();

  if (matching.some((e) => e.severity === "error")) {
    process.exit(1);
  }
}
