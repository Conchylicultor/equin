#!/usr/bin/env bun
import {
  assertCheckoutInstalled,
  CheckoutNotInstalledError,
} from "./bootstrap";

/**
 * The `SubagentStop` / `TeammateIdle` hook: an agent may not end its turn while
 * an op it started is still running.
 *
 * A separate entry point from `guard.ts` rather than a branch inside it,
 * because the two answer different questions with different payloads and
 * different output contracts — a PreToolUse hook speaks
 * `hookSpecificOutput.permissionDecision`, a stop hook speaks a top-level
 * `decision`, and Stop explicitly does not support the former.
 *
 * **Fails open, always.** Every path that is not a confident block exits 0 and
 * prints nothing. A hook that throws on an unexpected payload would block an
 * agent for a reason nobody could act on, which is a worse bug than the one
 * this fixes.
 *
 * Like `guard.ts`, this file loads only `./bootstrap` (node builtins) statically
 * and the hook proper (`./stop-hook`, which reaches `infra/worktree/server`)
 * dynamically — after checking the checkout is installed, so an uninstalled one
 * says so instead of resolving npm packages from main's tree.
 */

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const raw = Buffer.concat(chunks).toString("utf8");

try {
  assertCheckoutInstalled(import.meta.path);
} catch (err) {
  if (!(err instanceof CheckoutNotInstalledError)) throw err;
  process.stderr.write(`guards: stop guard skipped: ${err.message}\n`);
  process.exit(0);
}

process.stdout.write(await (await import("./stop-hook")).stopHook(raw));
