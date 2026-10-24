import { resolve } from "path";
// Reach the config reader through the database CORE barrel, not admin/server:
// the admin pool module's worktree connection string needs this process's runtime
// namespace, which a tooling/check subprocess does not have. The core barrel
// exposes exactly the config→env helpers for non-backend consumers and is
// import-safe by design (same precedent as
// plugins/database/plugins/migrations/check/index.ts). This used to be a
// hand-inlined third copy of the reader.
import { libpqEnv } from "@plugins/database/core";
// The plugin dir is drizzle-kit's cwd, and every relative path in
// drizzle.config.ts resolves against it (the `schema:` globs and `out`). Taking
// it from the migrations plugin rather than re-typing the literal is what keeps
// this check anchored where migration generation actually runs — a drifted copy
// would glob nothing and drizzle-kit would exit 0 having found no tables.
// `drizzleGenerateArgv` comes from the same barrel and for the same reason: the
// migrations plugin owns HOW its tool is invoked as well as from WHERE. It takes
// typed flags, so this check cannot express a subcommand that would dial the
// sentinel credentials in drizzle.config.ts.
// `stageDrizzleOut` is drizzle-kit's view of data/ — the journal and the
// snapshot DAG's single tip — because drizzle-kit aborts, exit 0 and nothing
// written, on a merged history: a copy of the whole dir would pass here
// silently after every upstream update.
import {
  drizzleGenerateArgv,
  MIGRATIONS_PLUGIN_DIR,
  stageDrizzleOut,
  UnjoinedSnapshotTipsError,
} from "@plugins/database/plugins/migrations/core";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const PROMPT_RE =
  /Is .+? (column in .+? table|table|schema|enum|view|sequence|role|policy) created or renamed/;

const check: Check = {
  id: "migrations-in-sync",
  description: "plugin schema files match committed migration files",
  async run() {
    const root = await getWorktreeRoot();
    const migrationsPluginDir = resolve(root, MIGRATIONS_PLUGIN_DIR);
    const committed = resolve(migrationsPluginDir, "data");

    let stage: Awaited<ReturnType<typeof stageDrizzleOut>>;
    try {
      stage = await stageDrizzleOut(migrationsPluginDir, committed);
    } catch (err) {
      // More than one snapshot tip: an unjoined fork, which is
      // snapshot-chain-intact's to diagnose. Stated, not passed.
      if (err instanceof UnjoinedSnapshotTipsError)
        return { ok: false, message: err.message };
      throw err;
    }
    try {
      // 20 buffered Enter keystrokes: enough to auto-advance any create-vs-rename
      // prompts drizzle shows (each defaults to "create"); the PROMPT_RE check
      // below still fails the run when prompts appeared. Delivered as whole-buffer
      // stdin — the prompts need no live parsing here, unlike migrations-interactive.
      const result = await spawnCaptured(
        drizzleGenerateArgv({ configPath: stage.configPath }),
        {
          cwd: migrationsPluginDir,
          stdin: new Uint8Array(20).fill(0x0d),
          // drizzle-kit generate is a schema read plus a diff — tens of seconds
          // at worst on this repo. The bound is here because this is the one
          // command in the check tree that is SHAPED to block on input: the 20
          // buffered keystrokes above exist precisely because it prompts, and a
          // prompt they don't answer is a child that waits forever. Five minutes
          // is an order of magnitude above the real duration, so only that wedge
          // trips it.
          timeoutMs: 300_000,
          // No namespace in the child's environment: drizzle-kit needs none (no
          // schema-glob file resolves one at module eval — `schema-files-loadable`
          // is the probe that keeps that true), and a namespace in an environment
          // is inherited by everything the child spawns in turn.
          env: {
            ...process.env,
            ...libpqEnv(),
            NO_COLOR: "1",
          },
        },
      );
      if (result.exitCode !== 0) {
        return {
          ok: false,
          message: `drizzle-kit generate failed:\n${result.stderr}`,
        };
      }
      // drizzle-kit exits 0 on its own failures (an unreadable snapshot, a
      // collision), having generated nothing — which reads here as "in sync".
      // Same guard as generateMigration's.
      if (
        /\b(error|collision|conflict|ENOENT)\b/i.test(result.stderr) ||
        /\b(collision|ENOENT)\b/i.test(result.stdout)
      ) {
        return {
          ok: false,
          message: `drizzle-kit generate printed a diagnostic but exited 0:\n${result.stdout}\n${result.stderr}`,
        };
      }

      if (PROMPT_RE.test(result.stdout)) {
        return {
          ok: false,
          message:
            "Schema has ambiguous changes (rename vs create) requiring interactive resolution.",
          hint:
            "Run `./equin build --migration-name <slug>` to see the detected prompts " +
            "and provide explicit --migration-answers.\n\n" +
            "AGENT: Stop here and report this to the user. Do not retry or work around this. " +
            "If this check fails unexpectedly, report the limitation clearly.",
        };
      }

      const added = stage.emitted().sql;
      if (added.length > 0) {
        return {
          ok: false,
          message: `plugin schema files diverge from committed migrations (would add: ${added.join(", ")})`,
          hint: "Run `./equin build` and commit the generated migration files.",
        };
      }
      return { ok: true };
    } finally {
      stage.dispose();
    }
  },
};

export default check;
