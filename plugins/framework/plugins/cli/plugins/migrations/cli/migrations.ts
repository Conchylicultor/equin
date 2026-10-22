import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
// The plugin dir is drizzle-kit's cwd, and every relative path in
// drizzle.config.ts resolves against it (the `schema:` globs and `out`). Taken
// from the migrations plugin rather than re-typed here: a drifted copy would run
// generation from a directory where the globs match nothing, and drizzle-kit
// exits 0 having discovered no tables — a silent DROP, not an error. Safe to
// import at module eval: migrations/core is a side-effect-free leaf (unlike
// @plugins/database/server, whose worktree pool wants a runtime namespace), and it
// reaches no registered pre-barrel/post-web codegen manifest, which is the
// property cli:codegen-manifests-not-frozen holds over the whole CLI process's
// import closure: a manifest frozen at CLI load is regenerated on disk by stage
// 2 but never re-read, and pruneOrphanedConfigFiles then deletes a
// freshly-authored config override.
// `drizzleGenerateArgv` comes from the same barrel and for the same reason: the
// migrations plugin owns HOW its tool is invoked (argv) as well as from WHERE
// (cwd), so neither can drift per call site.
// The phased-migration grammar and the statement table come from the same
// barrel: the migrations plugin owns what a schema migration file may say.
// So does what "published" means (`publishedMigrationBasenames`): the migrations
// on any `main` this checkout knows of are immutable, and everything else in
// data/ is this branch's own.
import {
  drizzleGenerateArgv,
  type EmittedSnapshot,
  isSchemaMigration,
  LOCAL_MAIN_REF,
  migrationClaimId,
  migrationContentHash,
  MIGRATIONS_DATA_DIR,
  MIGRATIONS_PLUGIN_DIR,
  parseMigration,
  phaseStatements,
  publishedMigrationOrigins,
  renderAdoptionMigration,
  renderPhasedMigration,
  renderSnapshotHeader,
  renderStatements,
  SCHEMA_SNAPSHOT_FILE,
  schemaLoadFailures,
  schemaMigrationFiles,
  schemaSnapshotPath,
  type Snapshot,
  snapshotBodies,
  type SnapshotLineage,
  stageDrizzleOut,
  type Supersession,
} from "@plugins/database/plugins/migrations/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  promptKey,
  runDrizzleKitWithPrompts,
  type DetectedPrompt,
  type MigrationAnswer,
} from "./migrations-interactive";
import {
  formatMigrationTimestamp,
  joinSnapshotTips,
  latestMigrationTimestamp,
  SnapshotJoinError,
} from "./snapshot-join";
import {
  readResetPrior,
  resetAdoption,
  resetLineage,
  type ResetPrior,
} from "./reset-lineage";
import { dropLegacyEntries, settleSnapshotFiles } from "./snapshot-files";

// The interactive drizzle-kit runner (the CLI's one sanctioned streaming-stdio
// child) and its prompt model live in ./migrations-interactive.ts; re-exported
// here so existing consumers (build.ts, regen-migrations.ts, the tests) keep
// their import site.
export {
  promptKey,
  resolveAnswer,
  runDrizzleKitWithPrompts,
} from "./migrations-interactive";
export type {
  PromptOption,
  DetectedPrompt,
  MigrationAnswer,
  DrizzlePromptResult,
} from "./migrations-interactive";

/**
 * Parse a `--migration-answers <json>` argv value into the answer list
 * `generateMigration` consumes. Lives HERE, beside `MigrationAnswer` itself,
 * rather than in one command: every command that can drive a migration
 * (`build`, `build --hermetic`) takes the same flag, and a second hand-rolled
 * copy of this validator is exactly how the three divergent `readDatabaseConfig`
 * readers this plan started by unifying came about.
 *
 * MAY TERMINATE THE PROCESS: exits 1 on malformed input. That is argv
 * validation — it runs before any artifact exists and owes no cleanup.
 */
export function parseMigrationAnswers(raw: string): MigrationAnswer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.error(
      `Error: --migration-answers is not valid JSON.\n` +
        `Expected: '[{"action":"create"},{"action":"rename","from":"old_name"}]'\n`,
    );
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error(
      `Error: --migration-answers must be a JSON array.\n` +
        `Expected: '[{"action":"create"},{"action":"rename","from":"old_name"}]'\n`,
    );
    process.exit(1);
  }
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (entry.action === "create") continue;
    if (entry.action === "rename" && typeof entry.from === "string") continue;
    console.error(
      `Error: --migration-answers[${i}] is invalid: ${JSON.stringify(entry)}\n` +
        `Each entry must be {"action":"create"} or {"action":"rename","from":"<source_name>"}.\n`,
    );
    process.exit(1);
  }
  return parsed as MigrationAnswer[];
}

/**
 * One persisted answer in a `meta/_<tag>_answers.json` sidecar. Carries the
 * entity identity (so it survives reordering on regen) plus the resolved action.
 */
export type KeyedAnswerEntry =
  | { key: string; entityType: string; entityName: string; action: "create" }
  | {
      key: string;
      entityType: string;
      entityName: string;
      action: "rename";
      from: string;
    };

interface AnswersSidecar {
  version: 1;
  answers: KeyedAnswerEntry[];
}

/**
 * The `meta/` filename holding migration `<tag>`'s answers.
 *
 * **The leading underscore is load-bearing.** drizzle-kit's `prepareOutFolder`
 * runs its pg-schema snapshot validator over every `meta/*.json` whose name does
 * NOT start with `_`, and a sidecar is not a snapshot — so an unprefixed one
 * makes drizzle print "data is malformed", exit 0, and generate nothing. That
 * blocks every subsequent build in the repo, permanently, from the first
 * answered prompt onward. `_journal.json` sits in that directory unmolested for
 * exactly this reason.
 *
 * The name is derived HERE, in one function, rather than interpolated at each of
 * the four call sites (writer, reader, two cleanup paths): a prefix that only
 * three of them apply is the same outage arriving later and harder to see.
 */
const ANSWERS_PREFIX = "_";
const ANSWERS_SUFFIX = "_answers.json";

export function answersSidecarName(tag: string): string {
  return `${ANSWERS_PREFIX}${tag}${ANSWERS_SUFFIX}`;
}

/**
 * Read every branch-local `meta/_*_answers.json` sidecar (those whose migration
 * `.sql` is not in `published` — see `publishedMigrationBasenames`) and merge their entries into one keyed
 * map. Main's accumulated sidecars are ignored, so a re-emitted prompt is only
 * ever resolved from this branch's own authored answers. Fails loud on malformed
 * JSON (lets JSON.parse throw).
 */
export function readBranchLocalAnswers(
  migrationsDir: string,
  published: ReadonlySet<string>,
): Map<string, MigrationAnswer> {
  const map = new Map<string, MigrationAnswer>();
  const metaDir = join(migrationsDir, "meta");
  if (!existsSync(metaDir)) return map;

  for (const f of readdirSync(metaDir)) {
    if (!f.startsWith(ANSWERS_PREFIX) || !f.endsWith(ANSWERS_SUFFIX)) continue;
    // A sidecar _<tag>_answers.json maps to migration <tag>.sql; skip sidecars
    // whose migration is published (their answers are immutable history).
    const tag = f.slice(ANSWERS_PREFIX.length, -ANSWERS_SUFFIX.length);
    const sqlBasename = `${tag}.sql`;
    if (published.has(sqlBasename)) continue;
    const raw = readFileSync(join(metaDir, f), "utf8");
    const parsed = JSON.parse(raw) as AnswersSidecar;
    for (const entry of parsed.answers) {
      map.set(
        entry.key,
        entry.action === "rename"
          ? { action: "rename", from: entry.from }
          : { action: "create" },
      );
    }
  }
  return map;
}

/**
 * Write a `meta/_<schemaTag>_answers.json` sidecar capturing the resolved
 * create-vs-rename decision for each prompt, keyed by entity identity so a later
 * regen can replay it. `resolve` yields the answer chosen for a given prompt.
 */
export function writeAnswersSidecar(
  metaDir: string,
  schemaTag: string,
  prompts: DetectedPrompt[],
  resolve: (p: DetectedPrompt) => MigrationAnswer,
): void {
  const answers: KeyedAnswerEntry[] = prompts.map((p) => {
    const a = resolve(p);
    const base = {
      key: promptKey(p),
      entityType: p.entityType,
      entityName: p.entityName,
    };
    return a.action === "rename"
      ? { ...base, action: "rename" as const, from: a.from }
      : { ...base, action: "create" as const };
  });
  const sidecar: AnswersSidecar = { version: 1, answers };
  writeFileSync(
    join(metaDir, answersSidecarName(schemaTag)),
    JSON.stringify(sidecar, null, 2) + "\n",
  );
}

// ─── (interactive runner moved to ./migrations-interactive.ts) ───────────────

const NEW_FORMAT = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;
// Drizzle-kit normally numbers files (0000, 0001, …) but emits "0NaN" when
// it can't derive the next index from existing (non-matching) filenames.
const DRIZZLE_FORMAT = /^(\d{4}|0NaN)_(.+)\.sql$/;
const MIGRATION_NAME_REGEX = /^[a-z0-9_]+$/;

// drizzle-kit --custom seeds every custom migration with this exact placeholder
// body (no trailing newline). Because the body is byte-identical across all
// custom migrations, so is its content hash (b3cc75fa) — and the runner keys
// applied-state by that hash (the filename's sha8). Two custom migrations would
// therefore claim the same hash, and the second is silently skipped by the
// runner (the hash is a PRIMARY KEY in __singularity_migrations). Before hashing
// in renameMigrations we rewrite the placeholder to embed the migration's unique
// timestamp+slug, giving every custom migration a distinct content hash while
// preserving the filename-hash == sha256(content) invariant the push-time
// hand-edit detector relies on.
const DRIZZLE_CUSTOM_PLACEHOLDER =
  "-- Custom SQL migration file, put your code below! --";

/** What a completed `generateMigration` reports back to its caller. */
export interface GenerateMigrationResult {
  /** Peak RSS (bytes) of the drizzle-kit child, when the runtime reported rusage. */
  maxRssBytes: number | undefined;
}

/**
 * Run `drizzle-kit generate`; detect whether it produced a new migration;
 * require --migration-name when it did; rename new files to the hash-based
 * format. Exits the process on error.
 *
 * POST-CONDITION: `meta/_journal.json` describes the `.sql` files on disk. It is
 * regenerated unconditionally — on entry, on every discard, and at the exit —
 * never as a side effect of having renamed or deleted something. The journal is
 * a pure re-encoding of the filenames, so a redundant regen writes identical
 * bytes; a MISSING one is how a branch-local data migration ends up orphaned
 * after the `regen-migrations` merge driver resolves the journal in main's
 * favour during a rebase. This function is the single funnel every caller
 * (`build`, `build --hermetic`, `regen-migrations`) reaches that repair
 * through.
 *
 * Regeneration is placed at explicit call sites rather than a `try/finally`:
 * `process.exit()` does not unwind the stack, and this function has six terminal
 * exits downstream of its first mutation.
 *
 * When drizzle-kit shows interactive rename/create prompts:
 * - Without migrationAnswers: discovers all prompts (auto-advancing with
 *   "create"), discards generated files, prints structured JSON, exits 2.
 * - With migrationAnswers: uses the provided semantic answers and proceeds.
 *
 * Returns the drizzle-kit child's peak RSS so the build can profile this phase
 * (it runs outside every host grant — see the memory-dimension plan doc).
 */
export async function generateMigration(opts: {
  root: string;
  migrationName?: string;
  resetMigration?: boolean;
  customMigration?: boolean;
  migrationAnswers?: MigrationAnswer[];
}): Promise<GenerateMigrationResult> {
  const {
    root,
    migrationName,
    resetMigration,
    customMigration,
    migrationAnswers,
  } = opts;

  if (migrationName && !MIGRATION_NAME_REGEX.test(migrationName)) {
    console.error(
      `Invalid --migration-name "${migrationName}". Use lowercase letters, digits, and underscores only.`,
    );
    process.exit(1);
  }

  const migrationsDir = resolve(root, MIGRATIONS_DATA_DIR);

  // Every step below splits data/ into published (immutable) and this branch's
  // own. Read once, before anything is generated: the set is a property of the
  // refs, which nothing here moves — and a throw here (no local `main`) leaves
  // no half-generated file behind.
  // Which `main` each published file is on: the tip join labels a conflict's
  // sides by it (this checkout vs upstream). Its key set is the published set.
  const origins = await publishedMigrationOrigins(root);
  const published: ReadonlySet<string> = new Set(origins.keys());

  // Snapshot bodies by id: only the tip is on disk, older ones are in git.
  // One resolver for the whole run, so a body read before the reset (or
  // before a join overwrites the tip) stays answerable after it.
  const bodies = snapshotBodies(root, migrationsDir);

  // Regen mode (resetMigration with no positional answers) replays the persisted
  // create-vs-rename decisions. Read the branch-local sidecars NOW — before the
  // reset below deletes them — so a re-emitted prompt resolves by entity identity.
  const keyedAnswers =
    resetMigration && !migrationAnswers
      ? readBranchLocalAnswers(migrationsDir, published)
      : undefined;

  // What the reset deletes, read before it does: the regenerated migration
  // names those hashes (`supersedes`) when it provably carries the same schema,
  // so a database that applied them adopts it instead of re-running its DDL.
  let resetPrior: ResetPrior | null = null;
  if (resetMigration) {
    resetPrior = await readResetPrior(migrationsDir, published, bodies);
    await resetBranchLocalMigrations(root, migrationsDir, published);
  }

  // Self-heal the filename-hash == content-hash invariant for branch-local data
  // migrations (snapshot-less .sql). A --custom migration freezes its hash at the
  // empty file when first generated; once the agent hand-edits the SQL the runner
  // (which identifies migrations by their filename hash) would otherwise silently
  // skip the new content or diverge across DBs. Re-hashing on every build keeps
  // the identity honest. Never touches published migrations — their hashes are
  // locked into every deployed DB.
  rehashBranchLocalDataMigrations(migrationsDir, published);

  // Join the snapshot DAG's tips — after the reset, so every tip left is
  // published (an upstream update's fork), and before drizzle-kit, which must
  // diff against the join. A branch-local tip (a rebase Y-fork) or a real
  // conflict stops here with the resolution, having written nothing.
  try {
    const joined = await joinSnapshotTips(migrationsDir, origins, bodies);
    if (joined.kind === "joined") {
      console.log(
        `  wrote merge node ${joined.file} (joins snapshots ${joined.parents.join(", ")})`,
      );
    }
  } catch (err) {
    if (!(err instanceof SnapshotJoinError)) throw err;
    regenerateJournal(migrationsDir);
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
  }

  // data/meta/ in its one shape: the tip's body in schema.snapshot.json, no
  // per-migration snapshot left (the cutover, when there are — see
  // ./snapshot-files.ts). After the join, so the tip is single.
  const settled = await settleSnapshotFiles(migrationsDir, bodies);
  if (settled.folded.length > 0)
    console.log(
      `  folded ${settled.folded.length} per-migration snapshot(s) into meta/legacy-snapshots.json`,
    );
  if (settled.wroteTip !== null)
    console.log(
      `  wrote meta/${SCHEMA_SNAPSHOT_FILE} (the snapshot DAG's tip, ${settled.wroteTip})`,
    );

  // Re-establish journal↔filename consistency before anything else runs. Two
  // paths get NO other regen: every abort between here and `renameMigrations`
  // exits the process, and a branch carrying only a data migration skips all
  // three downstream regens (reset preserves it, rehash finds its hash already
  // correct, drizzle emits no schema delta) — which is exactly the branch whose
  // journal entry the `regen-migrations` merge driver just resolved away in
  // main's favour. NOT about drizzle-kit's inputs: it picks the prior snapshot
  // off a sorted `readdir(meta)`, and reads the journal only for `idx`.
  regenerateJournal(migrationsDir);

  // drizzle-kit loads every schema-glob file with a synchronous require() and,
  // when one throws, skips it and exits 0 — generating a migration with that
  // file's tables silently missing, whatever the error was. Its output names
  // only the error kinds someone listed below; this asks the question itself,
  // by loading each file the way drizzle-kit will, before trusting a run.
  const loadFailures = await schemaLoadFailures(root);
  if (loadFailures.length > 0) {
    console.error(
      `\nError: ${loadFailures.length} schema file(s) cannot be loaded the way drizzle-kit\n` +
        "loads them, so their tables would be SILENTLY DROPPED from migration generation:\n" +
        loadFailures.map((f) => `  ${f.file} — ${f.error}`).join("\n") +
        "\n\nFix the offending import (`./singularity check schema-files-loadable` names\n" +
        "the same files); never generate around it.",
    );
    process.exit(1);
  }

  const before = new Set(readdirSync(migrationsDir));

  // drizzle-kit reads a staged out-dir holding only the journal and the DAG's
  // single tip, never data/ itself: it aborts (exit 0, nothing written) on any
  // two snapshots sharing a prevId, which every merged history has. What it
  // emits is moved into data/ right after it exits, so everything below sees
  // the files exactly where drizzle-kit used to write them.
  const cwd = resolve(root, MIGRATIONS_PLUGIN_DIR);
  const stage = await stageDrizzleOut(cwd, migrationsDir);

  // The argv comes from the migrations plugin, which owns it: the binary name and
  // `generate` are welded together there (with the load-bearing `--bun` flag), so
  // this call site configures FLAGS and cannot express another subcommand.
  const cmd = drizzleGenerateArgv({
    custom: customMigration,
    name: migrationName,
    configPath: stage.configPath,
  });

  let result: Awaited<ReturnType<typeof runDrizzleKitWithPrompts>>;
  // What drizzle-kit wrote beside a new migration. Held in memory, never put
  // in data/ until the migration is kept: every discard below then has no
  // snapshot to restore.
  let emitted: EmittedSnapshot | null;
  try {
    result = await runDrizzleKitWithPrompts({
      cmd,
      cwd,
      // No `env` at all, so the child simply inherits this process's. `generate`
      // is a pure snapshot diff against ./data and opens no connection, and
      // drizzle.config.ts reads no database config — passing libpqEnv() here is
      // what made this step ENOENT on a host with no
      // ~/.singularity/state/db-config/database.json. The worktree name used to be
      // passed too; the schema files never needed it (no schema-glob file resolves
      // a namespace at module eval, and the database client defers its identity to
      // the first query), and a namespace in an environment is inherited by
      // everything drizzle-kit itself spawns.
      answers: migrationAnswers ?? null,
      keyedAnswers,
      echo: true,
    });
    emitted = stage.moveEmittedInto(migrationsDir).snapshot;
  } finally {
    stage.dispose();
  }

  if (result.exitCode !== 0) {
    discardGenerated(
      migrationsDir,
      readdirSync(migrationsDir).filter(
        (f: string) => f.endsWith(".sql") && !before.has(f),
      ),
    );
    process.exit(1);
  }
  const combined = `${result.stdoutBuf}\n${result.stderrBuf}`;

  // drizzle-kit reports its own failures and still exits 0 having written
  // nothing: a snapshot collision ("… is a collision", printed to STDOUT) or a
  // snapshot it could not read (ENOENT, e.g. a misplaced out-dir). Either one,
  // on either stream, in whatever dir it ran in, is a failure — never "no
  // schema change".
  if (
    /\b(error|collision|conflict)\b/i.test(result.stderrBuf) ||
    /\b(collision|ENOENT)\b/i.test(combined)
  ) {
    discardGenerated(
      migrationsDir,
      readdirSync(migrationsDir).filter(
        (f: string) => f.endsWith(".sql") && !before.has(f),
      ),
    );
    console.error(
      "\nError: drizzle-kit printed a diagnostic but exited 0. Treating as failure.\n" +
        "If this is a snapshot-chain collision, rebase onto main, then re-run\n" +
        "  ./singularity build --reset-migration --migration-name <slug>\n" +
        "to drop this branch's migration and regenerate it against the new tip.\n" +
        "(drizzle-kit only ever sees the staged single-tip view of data/, so a collision\n" +
        "there means the staging itself is broken: report it, do not work around it.)",
    );
    process.exit(1);
  }

  // drizzle-kit's `prepareOutFolder` runs the pg-schema validator over EVERY
  // `meta/*.json` whose name doesn't start with `_` — which sweeps in our
  // `*_answers.json` sidecars, which are not snapshots and never parse. On a
  // failure it prints "<file> data is malformed" to STDOUT (hence `combined`,
  // not stderrBuf) and calls process.exit(0). Paired with the `added.length ===
  // 0` early return below, that would silently stop migration generation
  // repo-wide from the first answers sidecar that lands on main. Fail loud.
  if (/\bdata is malformed\b/i.test(combined)) {
    console.error(
      "\nError: drizzle-kit rejected a file in meta/ as malformed and exited 0 —\n" +
        "no migration was generated, silently. Its snapshot validator scans every\n" +
        "meta/*.json not starting with '_', including our *_answers.json sidecars.\n" +
        "The offending file is named in the output above.\n\n" +
        "AGENT: Stop here and report this to the user. Do NOT delete the file to make\n" +
        "the message go away — a malformed snapshot breaks the chain for everyone.",
    );
    process.exit(1);
  }

  if (
    /require\(\) async module|async module.*unsupported|\bTypeError\b|Cannot find module|Cannot use import statement/i.test(
      combined,
    )
  ) {
    console.error(
      "\nError: drizzle-kit exited 0 but failed to load a schema file — the table(s) it\n" +
        "defines would be SILENTLY DROPPED from migration generation. A schema-glob file\n" +
        "(server/**/internal/{tables,schema}.ts) has an async-only module (top-level await,\n" +
        "e.g. lexical/@lexical/yjs) in its import graph. Fix the offending import; run\n" +
        "`./singularity check schema-files-loadable` to see exactly which file.",
    );
    process.exit(1);
  }

  // INVARIANT: never keep a migration generated with prompts unless answers were
  // provided. In keyed (regen) mode `migrationAnswers` is undefined but answers
  // come from the sidecar map — so exclude keyed mode here; its own unanswered
  // check below handles the abort.
  if (result.detectedPrompts.length > 0 && !migrationAnswers && !keyedAnswers) {
    const added = readdirSync(migrationsDir).filter(
      (f: string) => f.endsWith(".sql") && !before.has(f),
    );
    discardGenerated(migrationsDir, added);
    console.log("\nMIGRATION_PROMPTS_DETECTED");
    console.log(JSON.stringify(result.detectedPrompts, null, 2));
    console.error(
      "\ndrizzle-kit encountered ambiguous schema changes that require explicit answers.\n" +
        "Re-run with --migration-answers to provide choices. Example:\n" +
        `  ./singularity build --migration-name <slug> --migration-answers '${JSON.stringify(result.detectedPrompts.map(() => ({ action: "create" })))}'\n\n` +
        "AGENT: Stop here and report this to the user. Show them the detected prompts\n" +
        "above and ask which action to take for each. Do not auto-select or retry\n" +
        "without explicit user input. If this feature does not work as expected or\n" +
        "has limitations, report that clearly rather than working around it.\n",
    );
    process.exit(2);
  }

  // Keyed (regen) mode: a re-emitted prompt had no persisted answer (or its
  // rename source was missing). Discard the generated files and stop loudly —
  // the sidecar must be (re-)authored before push can normalize this branch.
  if (keyedAnswers && result.unanswered.length > 0) {
    const added = readdirSync(migrationsDir).filter(
      (f: string) => f.endsWith(".sql") && !before.has(f),
    );
    discardGenerated(migrationsDir, added);
    console.error(
      "\ndrizzle-kit showed an ambiguous create-vs-rename prompt with no persisted answer:\n" +
        result.unanswered.map((k) => `  ${k}`).join("\n") +
        "\n\nThe regen replays answers from meta/<tag>_answers.json, but these keys are\n" +
        "absent (a new ambiguity introduced after the original authoring). Author the\n" +
        "decision first on the original migration via:\n" +
        "  ./singularity build --migration-name <slug> --migration-answers '[...]'\n\n" +
        "AGENT: Stop here and report this to the user. Do not retry or hand-edit the\n" +
        "generated SQL — the create-vs-rename choice must be made explicitly.\n",
    );
    process.exit(2);
  }

  const added = readdirSync(migrationsDir).filter(
    (f: string) => f.endsWith(".sql") && !before.has(f),
  );

  if (added.length === 0) {
    if (migrationName) {
      console.warn(
        "--migration-name was provided but no schema change was detected; ignoring.",
      );
    }
    // The reset regenerated nothing: the deleted delta is already in the
    // published schema, through migrations a database that applied the deleted
    // ones has not run. Name them in an adoption file, so such a database
    // records them instead of redoing their DDL.
    if (resetPrior !== null) {
      const adoption = await resetAdoption(migrationsDir, resetPrior, bodies);
      if (adoption.kind === "adopts") {
        const file = writeAdoptionMigration(
          migrationsDir,
          adoption.adopts,
          adoption.supersedes,
        );
        console.log(
          `  wrote ${file}: adopts ${adoption.files.join(", ")} (main's migrations made the change the deleted ${adoption.supersedes.direct.join(", ")} made: a database that applied those records these without running their DDL)`,
        );
        regenerateJournal(migrationsDir);
      } else if (adoption.reason !== null) {
        warnUnsuperseded(
          resetPrior,
          `the reset regenerated no schema migration, and ${adoption.reason}`,
        );
      }
    }
    return { maxRssBytes: result.maxRssBytes };
  }

  if (!migrationName) {
    discardGenerated(migrationsDir, added);
    console.error(
      "\nError: DB schema change detected — a new migration is required, but --migration-name was not provided.\n" +
        "\n" +
        "Re-run with:\n" +
        "  ./singularity build --migration-name <short_slug>\n" +
        "\n" +
        "Examples:\n" +
        "  --migration-name add_task_priority      (added a column/table)\n" +
        "  --migration-name remove_yak_shaving     (removed a plugin's tables)\n" +
        "\n" +
        "If you removed a plugin or table: this is expected — drizzle generates a DROP TABLE\n" +
        "migration automatically. Do NOT delete migration files or snapshots by hand;\n" +
        "that breaks the snapshot chain for every other agent.\n",
    );
    process.exit(1);
  }

  // Phase the freshly generated schema migration into expand / contract and
  // record the branch-local data migrations it claims — BEFORE
  // renameMigrations hashes the content, so the committed filename's sha8
  // matches the phased body. A --custom data migration is never phased: it is
  // what gets claimed.
  if (!customMigration) {
    if (emitted === null) {
      discardGenerated(migrationsDir, added);
      console.error(
        `\nError: drizzle-kit generated ${added.join(", ")} but no snapshot beside it — nothing to record as the new tip.\n` +
          "AGENT: Stop here and report this to the user.",
      );
      process.exit(1);
    }
    let supersedes: Supersession | null = null;
    if (resetPrior !== null) {
      const lineage = await resetLineage(
        migrationsDir,
        resetPrior,
        JSON.parse(emitted.text) as Snapshot,
        bodies,
      );
      if (lineage.kind === "supersedes") {
        supersedes = lineage.supersedes;
        console.log(
          `  supersedes ${supersedes.direct.join(", ")} (same schema: a database that applied them adopts the new migration)`,
        );
      } else if (lineage.reason !== null) {
        warnUnsuperseded(resetPrior, lineage.reason);
      }
    }
    try {
      phaseGeneratedMigrations(migrationsDir, published, supersedes, {
        id: emitted.id,
        parents: [emitted.prevId],
      });
    } catch (err) {
      discardGenerated(migrationsDir, added);
      console.error(`\nError: ${(err as Error).message}\n`);
      console.error(
        "The generated schema migration was discarded. Change schema.ts so drizzle emits only\n" +
          "statements the phase table places (see plugins/database/plugins/migrations/CLAUDE.md,\n" +
          "'Phased schema migrations'), or extend the table if the statement is legitimate.",
      );
      process.exit(1);
    }
  }

  const renameResult = renameMigrations(migrationsDir);
  for (const r of renameResult.renamed) {
    console.log(`  ${r.from} → ${r.to}`);
  }

  // The kept schema migration's snapshot is the new tip. Data/backfill
  // migrations (--custom) carry no schema delta, so they must NOT join the
  // drizzle snapshot chain — otherwise they Y-fork against any schema migration
  // main adds concurrently, and pushing them becomes impossible outside a quiet
  // window. Their emitted snapshot is simply never written: the migration stays
  // a .sql + journal entry, applied by the runner via filename hash, and the
  // tip stays the last *schema* snapshot, which is correct since this one
  // changed no schema.
  if (!customMigration) {
    writeFileSync(schemaSnapshotPath(migrationsDir), emitted!.text);
  }

  // Persist the create-vs-rename decision alongside the migration so a later
  // regen (which re-emits a consolidated migration) replays it instead of
  // re-prompting and aborting the push. Only schema migrations that actually
  // showed prompts get a sidecar — the single renamed entry that is a schema
  // migration (data/custom ones carry no snapshot header and never prompt).
  if (result.detectedPrompts.length > 0) {
    const metaDir = join(migrationsDir, "meta");
    const schemaRename = renameResult.renamed.find((r) =>
      isSchemaMigration(migrationsDir, r.to),
    );
    if (schemaRename) {
      const schemaTag = schemaRename.to.slice(0, -4);
      // Keyed mode resolves by entity identity; authoring mode pairs prompt i
      // with the positional answer i (detect-mode order matches answer order).
      const resolver = keyedAnswers
        ? (p: DetectedPrompt) => keyedAnswers.get(promptKey(p))!
        : (p: DetectedPrompt) =>
            migrationAnswers![result.detectedPrompts.indexOf(p)]!;
      writeAnswersSidecar(metaDir, schemaTag, result.detectedPrompts, resolver);
      console.log(`  wrote answers sidecar ${answersSidecarName(schemaTag)}`);
    }
  }

  // The post-condition, stated at the exit rather than left to be inferred from
  // `renameMigrations`' own call: whatever this function did, the journal it
  // leaves behind describes the `.sql` files on disk.
  regenerateJournal(migrationsDir);

  return { maxRssBytes: result.maxRssBytes };
}

/**
 * Re-derive the filename hash from current content for branch-local data
 * migrations — NEW_FORMAT .sql files that are not schema migrations
 * (`isSchemaMigration`) and not published. Keeps filename-hash == content-hash so the runner (which
 * identifies migrations by filename hash) never silently skips hand-edited
 * backfill SQL. Preserves the timestamp (and thus ordering); only the hash token
 * changes. Schema migrations are left untouched — their SQL
 * must match the snapshot's DDL and must never be silently re-hashed.
 * Published files are immutable (their hash is recorded in deployed DBs).
 *
 * Does NOT touch the journal: its caller regenerates unconditionally right
 * after. Regenerating here only when a rename happened is how a branch-local
 * data migration whose hash was already correct could end up with no journal
 * entry at all.
 */
function rehashBranchLocalDataMigrations(
  migrationsDir: string,
  published: ReadonlySet<string>,
): void {
  const schema = schemaMigrationFiles(migrationsDir);

  for (const f of readdirSync(migrationsDir)) {
    const m = NEW_FORMAT.exec(f);
    if (!m) continue;
    if (published.has(f)) continue; // published — immutable
    const [, date, time, oldHash, name] = m;
    // A schema migration; skip (its SQL is snapshot-bound).
    if (schema.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    const newHash = migrationContentHash(sql);
    if (newHash === oldHash) continue;
    const newName = `${date}_${time}_${newHash}__${name}.sql`;
    renameSync(join(migrationsDir, f), join(migrationsDir, newName));
    console.log(`  rehashed data migration ${f} → ${newName}`);
  }
}

/**
 * Delete schema migration files that exist in the working tree but are not
 * published (`publishedMigrationBasenames`). Used by `--reset-migration`
 * to recover from a snapshot-chain Y-fork after rebasing onto main: the
 * branch-local migration is dropped so drizzle-kit can re-emit a fresh one
 * against the rebased tip.
 *
 * Only ever touches files absent from every published `main`, so a shared
 * migration — the author's, the user's own landed one, or upstream's after an
 * update — cannot be removed by accident.
 *
 * The tip body goes back with them: `meta/schema.snapshot.json` is restored
 * from `merge-base(HEAD, main)` — the published tip this branch grew from. A
 * rebase in which only the branch touched that file raises no conflict, so no
 * merge driver ever resets it; this is the one place that does. (A merge-base
 * from before the snapshot cutover has no such file: it is removed, and
 * `settleSnapshotFiles` writes the tip's body.)
 *
 * Does NOT touch the journal: its caller regenerates unconditionally right
 * after. Regenerating here only when something was actually removed is how a
 * branch carrying only a (deliberately preserved) data migration took the
 * early return below and left a stale journal behind.
 */
async function resetBranchLocalMigrations(
  root: string,
  migrationsDir: string,
  published: ReadonlySet<string>,
): Promise<void> {
  const metaDir = join(migrationsDir, "meta");
  const schema = schemaMigrationFiles(migrationsDir);

  const removed: string[] = [];
  for (const f of readdirSync(migrationsDir)) {
    if (!f.endsWith(".sql")) continue;
    if (published.has(f)) continue;
    // Preserve data migrations: plain drizzle generate can't recreate their
    // hand-written SQL, so deleting them here would lose the backfill. They
    // never join the snapshot chain, so they don't need resetting.
    if (!schema.has(f)) continue;
    rmSync(join(migrationsDir, f), { force: true });
    removed.push(f);
    // Drop the answers sidecar too — regen reads it before this reset runs, so
    // the in-memory keyed map already captured it; the on-disk copy is rewritten
    // for the consolidated migration after generate.
    rmSync(join(metaDir, answersSidecarName(f.slice(0, -4))), { force: true });
  }
  // A branch from before the snapshot cutover: its own per-migration
  // snapshots, and the entries the cutover folded them into.
  for (const f of readdirSync(metaDir)) {
    if (!f.endsWith("_snapshot.json")) continue;
    if (published.has(f)) continue;
    rmSync(join(metaDir, f), { force: true });
    removed.push(`meta/${f}`);
  }
  dropLegacyEntries(
    migrationsDir,
    removed.filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4)),
  );

  if (removed.length === 0) {
    console.log(
      "(--reset-migration: no branch-local migrations found, nothing to reset)",
    );
    return;
  }

  for (const f of removed) console.log(`  removed ${f}`);
  await restorePublishedTip(root, migrationsDir);
}

// Put back `meta/schema.snapshot.json` as it is at merge-base(HEAD, main), or
// remove it when that commit has none (see resetBranchLocalMigrations).
async function restorePublishedTip(
  root: string,
  migrationsDir: string,
): Promise<void> {
  const git = async (args: string[]) => {
    const r = await spawnCaptured(["git", ...args], {
      cwd: root,
      timeoutMs: 120_000,
    });
    if (r.timedOut) throw new Error(`git ${args.join(" ")} timed out`);
    return r;
  };
  const base = await git(["merge-base", "HEAD", LOCAL_MAIN_REF]);
  if (base.exitCode !== 0)
    throw new Error(
      `git merge-base HEAD ${LOCAL_MAIN_REF} failed (exit ${base.exitCode}): ${base.stderr.trim()}`,
    );
  const sha = base.stdout.trim();
  const rel = `${MIGRATIONS_DATA_DIR}/meta/${SCHEMA_SNAPSHOT_FILE}`;
  const listed = await git(["ls-tree", "--name-only", sha, "--", rel]);
  if (listed.exitCode !== 0)
    throw new Error(`git ls-tree ${sha} failed: ${listed.stderr.trim()}`);
  const path = schemaSnapshotPath(migrationsDir);
  if (listed.stdout.trim() === "") {
    rmSync(path, { force: true });
    return;
  }
  const shown = await git(["show", `${sha}:${rel}`]);
  if (shown.exitCode !== 0)
    throw new Error(`git show ${sha}:${rel} failed: ${shown.stderr.trim()}`);
  writeFileSync(path, shown.stdout);
  console.log(
    `  restored meta/${SCHEMA_SNAPSHOT_FILE} from ${sha.slice(0, 12)} (merge-base with main)`,
  );
}

export interface RenameResult {
  renamed: Array<{ from: string; to: string; hash: string }>;
}

export function renameMigrations(migrationsDir: string): RenameResult {
  const renamed: RenameResult["renamed"] = [];

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (NEW_FORMAT.test(file)) continue;
    const m = DRIZZLE_FORMAT.exec(file);
    if (!m) continue;
    const [, , name] = m;

    const sqlPath = join(migrationsDir, file);
    // Now — but never at or before an existing migration: a merge node is
    // stamped latest + 1s, and a fresh migration must sort after it (drizzle-kit
    // and the runner both order by filename).
    const latest = latestMigrationTimestamp(readdirSync(migrationsDir));
    const ts = formatMigrationTimestamp(
      Math.max(Date.now(), latest === null ? 0 : latest + 1000),
    );
    let sql = readFileSync(sqlPath, "utf8");
    if (sql.trim() === DRIZZLE_CUSTOM_PLACEHOLDER) {
      // Uniquify the empty custom-migration body so its content hash is distinct
      // (see DRIZZLE_CUSTOM_PLACEHOLDER). The marker is keyed to this file's
      // timestamp+slug — which the filename also encodes — so hash-uniqueness
      // tracks filename-uniqueness. The agent writes the real backfill SQL below
      // it; the next build re-derives the hash from the edited content
      // (rehashBranchLocalDataMigrations), so the marker only seeds the identity.
      sql = `${DRIZZLE_CUSTOM_PLACEHOLDER}\n-- migration: ${ts}__${name} --\n`;
      writeFileSync(sqlPath, sql);
    }
    const hash = migrationContentHash(sql);
    const newName = `${ts}_${hash}__${name}.sql`;

    renameSync(sqlPath, join(migrationsDir, newName));

    renamed.push({ from: file, to: newName, hash });
  }

  regenerateJournal(migrationsDir);
  return { renamed };
}

// ─── Phasing a generated schema migration ────────────────────────────────────

/**
 * Rewrite the freshly generated (not-yet-renamed) schema migration in
 * `migrationsDir` into the phased grammar: its statements split into expand and
 * contract by the migrations plugin's closed statement table, plus the claims
 * the runner resolves into `expand → claimed data migrations → contract`.
 *
 * It claims every BRANCH-LOCAL data migration (a NEW_FORMAT `.sql` that is
 * not a schema migration, absent from `published`) that no other branch-local
 * phased schema migration already claims. They all sort before it: the new file
 * is only stamped by `renameMigrations`, after this, with the current time.
 * After push's `regen-migrations` the single merged file therefore claims all of
 * the branch's data migrations — one push, one explicit group.
 *
 * The file starts with its snapshot header (`lineage`: the id drizzle-kit gave
 * the snapshot it emitted, and the tip it diffed against) — which is what
 * makes it a schema migration from then on.
 *
 * Throws, naming the statement, when the table rejects or does not recognise a
 * statement; the caller discards the generation. `published` is the set of
 * published migration basenames (`publishedMigrationBasenames`).
 */
export function phaseGeneratedMigrations(
  migrationsDir: string,
  published: ReadonlySet<string>,
  supersedes: Supersession | null,
  lineage: SnapshotLineage,
): void {
  const files = readdirSync(migrationsDir).sort();
  const fresh = freshSchemaMigration(migrationsDir);
  if (fresh === null) return;

  const schema = schemaMigrationFiles(migrationsDir);
  const hasSnapshot = (f: string) => schema.has(f);
  const branchLocal = files.filter(
    (f) => NEW_FORMAT.test(f) && !published.has(f),
  );

  const claimed = new Set<string>();
  for (const f of branchLocal.filter(hasSnapshot)) {
    const parsed = parseMigration(readFileSync(join(migrationsDir, f), "utf8"));
    if (parsed.kind === "phased") for (const c of parsed.claims) claimed.add(c);
  }
  // A snapshot-less phased file is an adoption file, not a data migration: it
  // runs no SQL and is never claimed.
  const isData = (f: string) =>
    !hasSnapshot(f) &&
    parseMigration(readFileSync(join(migrationsDir, f), "utf8")).kind ===
      "legacy";
  const claims = branchLocal
    .filter(isData)
    .map(migrationClaimId)
    .filter((id) => !claimed.has(id));

  const sqlPath = join(migrationsDir, fresh);
  const phased = phaseStatements(readFileSync(sqlPath, "utf8"));
  writeFileSync(
    sqlPath,
    renderSnapshotHeader(lineage) +
    renderPhasedMigration({
      expand: renderStatements(phased.expand),
      contract: renderStatements(phased.contract),
      claims,
      supersedes,
    }),
  );
}

/**
 * The schema migration drizzle-kit just generated (named in its own `NNNN_`
 * format until `renameMigrations` stamps it), or null when it generated none.
 * Throws on more than one.
 */
export function freshSchemaMigration(migrationsDir: string): string | null {
  const fresh = readdirSync(migrationsDir)
    .sort()
    .filter(
      (f) =>
        f.endsWith(".sql") && !NEW_FORMAT.test(f) && DRIZZLE_FORMAT.test(f),
    );
  if (fresh.length === 0) return null;
  if (fresh.length > 1) {
    throw new Error(
      `expected one freshly generated schema migration, found ${fresh.length}: ${fresh.join(", ")}`,
    );
  }
  return fresh[0]!;
}

// Write the adoption file for `adopts` (published hashes) and the lineage that
// already applied their delta, stamped after every migration on disk (it must
// sort after what it adopts). Returns its file name.
function writeAdoptionMigration(
  migrationsDir: string,
  adopts: readonly string[],
  supersedes: Supersession,
): string {
  const sql = renderAdoptionMigration(adopts, supersedes);
  const latest = latestMigrationTimestamp(readdirSync(migrationsDir));
  const ts = formatMigrationTimestamp(
    Math.max(Date.now(), latest === null ? 0 : latest + 1000),
  );
  const file = `${ts}_${migrationContentHash(sql)}__adopt_published.sql`;
  writeFileSync(join(migrationsDir, file), sql);
  return file;
}

// A reset deleted migrations a database may have applied, and the new file
// does not supersede them: such a database (this worktree's, if it built them)
// will fail to apply the new file. Say so now, with the way out, rather than
// leaving the next boot to discover it.
function warnUnsuperseded(prior: ResetPrior, reason: string): void {
  console.warn(
    `\nWarning: the reset deleted ${prior.deleted.map((d) => d.file).join(", ")}, and the regenerated migration\n` +
      `does not supersede them: ${reason}.\n` +
      "A database that applied them (this worktree's, if it built them) will fail to apply\n" +
      "the regenerated migration. Re-fork it from main after this build or push:\n" +
      "  ./singularity db fork --replace\n",
  );
}

/**
 * Remove generated `.sql` files and their answers sidecars. Their snapshot was
 * never written to `data/` (`generateMigration` holds it in memory until it
 * keeps the migration), so there is none to remove or restore.
 */
export function removeGeneratedFiles(
  migrationsDir: string,
  files: string[],
): void {
  const metaDir = join(migrationsDir, "meta");
  for (const f of files) {
    if (!f.endsWith(".sql")) continue;
    rmSync(join(migrationsDir, f), { force: true });
    // Drop any answers sidecar keyed to this migration's tag (the .sql basename).
    rmSync(join(metaDir, answersSidecarName(f.slice(0, -4))), { force: true });
  }
}

/**
 * Discard a rejected drizzle-kit generation: remove the emitted files AND
 * restore the journal.
 *
 * The second half is not optional. drizzle-kit's `writeResult` appends to
 * `meta/_journal.json` and writes it BEFORE the `.sql`, so by the time we decide
 * to reject a generation the journal already carries a `0NaN_<name>` row.
 * `removeGeneratedFiles` deletes the `.sql` and the answers sidecar — it has
 * no way to know about that row, and left behind it fails
 * `migration-metadata-consistent` as an orphanJournal entry. Every caller below
 * then exits the process, so this is their only chance to leave a consistent
 * tree.
 *
 * Kept separate from `removeGeneratedFiles` rather than folded into it: that
 * function is exported and its name promises removal, nothing more.
 */
function discardGenerated(migrationsDir: string, files: string[]): void {
  removeGeneratedFiles(migrationsDir, files);
  regenerateJournal(migrationsDir);
}

/** One `meta/_journal.json` entry. Deliberately carries no `idx` — see below. */
export interface JournalEntry {
  version: "7";
  when: number;
  tag: string;
  hash: string;
  breakpoints: true;
}

/**
 * Derive the journal entries for a set of migration filenames. PURE — the
 * journal is nothing but a re-encoding of the `.sql` names on disk, which is
 * exactly what makes rewriting it a safe post-condition rather than a mutation.
 *
 * Names that don't match NEW_FORMAT are ignored, agreeing with the runtime
 * runner's own MIGRATION_RE filter: a name neither can parse is inert in both,
 * and `migration-metadata-consistent`'s orphanSql is what surfaces it.
 *
 * Emits NO `idx` field, on purpose. drizzle-kit computes `idx = lastEntry.idx +
 * 1`, which against our journal is `NaN`, so it prefixes freshly generated files
 * `0NaN_` — which is precisely why DRIZZLE_FORMAT accepts `0NaN`. "Helpfully"
 * adding `idx` here would silently switch drizzle back to numbered prefixes.
 */
export function journalEntriesForSqlFiles(files: string[]): JournalEntry[] {
  return [...files]
    .filter((f) => NEW_FORMAT.test(f))
    .sort()
    .map((f) => {
      const m = NEW_FORMAT.exec(f);
      if (!m) throw new Error(`unreachable: ${f}`);
      const [, date, time, hash] = m;
      const when = Date.UTC(
        +date!.slice(0, 4),
        +date!.slice(4, 6) - 1,
        +date!.slice(6, 8),
        +time!.slice(0, 2),
        +time!.slice(2, 4),
        +time!.slice(4, 6),
      );
      return {
        version: "7" as const,
        when,
        tag: f.slice(0, -4),
        hash: hash!,
        breakpoints: true as const,
      };
    });
}

/**
 * Rewrite `meta/_journal.json` so it matches the `.sql` files on disk.
 *
 * A POST-CONDITION of the migration pipeline, never a side effect of having
 * changed something — `generateMigration` calls it unconditionally, and on an
 * already-consistent tree it rewrites byte-identical content. That is what
 * repairs a journal the `regen-migrations` merge driver resolved in main's
 * favour during a rebase; see the docblock on `generateMigration`.
 */
export function regenerateJournal(migrationsDir: string): void {
  const entries = journalEntriesForSqlFiles(readdirSync(migrationsDir));
  writeFileSync(
    join(migrationsDir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2) +
      "\n",
  );
}
