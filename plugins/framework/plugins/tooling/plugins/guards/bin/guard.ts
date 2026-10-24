#!/usr/bin/env bun
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { WORKSPACE_ROOT_ENV } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";
import { runHook } from "../core/runner";

/**
 * The directories outside the checkout an agent may write into, read from their
 * owners' declarations at hook time.
 *
 * `bin/` is where this can happen at all: a `data-dirs` module is importable
 * from `server`/`shared`/`bin`, never from `core/`, so the guards themselves
 * cannot name a data dir (see `GuardContext.writableDataDirs`). Reading
 * `.path` here — a getter, resolved per read — is what keeps the guard aligned
 * with the declaration when the directory moves.
 *
 * Prototypes qualify precisely because they are NOT in git: `prototypes/CLAUDE.md`
 * tells every agent to write its mock into this tree, and the declaration's
 * `reclaim: never` says the folder on disk is the only copy of that work.
 */
const writableDataDirs = [prototypesDir.path];

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const raw = Buffer.concat(chunks).toString("utf8");

let input: unknown = {};
if (raw.trim()) {
  try {
    input = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // malformed input — allow (don't block tool use on parse failure)
    process.exit(0);
  }
}

// Set by an app launch for every workspace kind; absent in a human session.
const workspaceRoot = process.env[WORKSPACE_ROOT_ENV] || null;

await runHook(input as Parameters<typeof runHook>[0], {
  writableDataDirs,
  workspaceRoot,
});
