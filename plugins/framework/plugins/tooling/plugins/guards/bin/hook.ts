import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { runHook } from "../core/runner";

/**
 * The PreToolUse hook proper: the payload Claude Code piped in → what to print
 * on stdout ("" lets the call through silently). Loaded and run by the
 * bootstrap (`./guard.ts`), which falls back to main's guard when THIS module
 * — or anything it imports — cannot load or throws.
 */
export async function guardHook(raw: string): Promise<string> {
  let input: unknown = {};
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // malformed input — allow (don't block tool use on parse failure)
      return "";
    }
  }
  const output = await runHook(input as Parameters<typeof runHook>[0], {
    /**
     * The directories outside the checkout an agent may write into, read from
     * their owners' declarations at hook time.
     *
     * `bin/` is where this can happen at all: a `data-dirs` module is
     * importable from `server`/`shared`/`bin`, never from `core/`, so the
     * guards themselves cannot name a data dir (see
     * `GuardContext.writableDataDirs`). Reading `.path` here — a getter,
     * resolved per read — is what keeps the guard aligned with the declaration
     * when the directory moves.
     *
     * Prototypes qualify precisely because they are NOT in git:
     * `prototypes/CLAUDE.md` tells every agent to write its mock into this
     * tree, and the declaration's `reclaim: never` says the folder on disk is
     * the only copy of that work.
     */
    writableDataDirs: [prototypesDir.path],
    // Set by an app launch for every workspace kind; absent in a human session.
    workspaceRoot: readEnv("WORKSPACE_ROOT") || null,
  });
  return output === null ? "" : JSON.stringify(output);
}
