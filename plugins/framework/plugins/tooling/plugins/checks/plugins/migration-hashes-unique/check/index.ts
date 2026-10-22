import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  MIGRATIONS_DATA_DIR,
  publishedMigrationBasenames,
  publishedMigrationRefsSignature,
} from "@plugins/database/plugins/migrations/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  cacheSignature?(): string | null | Promise<string | null>;
};

// <ts>_<sha8>__<slug>.sql — the runner (server/internal/runner.ts) keys applied
// state by the sha8 hash token, which is the PRIMARY KEY of __singularity_migrations.
const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

// ---------------------------------------------------------------------------
// Pure classifier (no fs/git) — exported for unit testing.
//
// Each sha8 group with >1 file is classified by reading the actual file
// CONTENTS (sha8 is derived from content, so true collisions are byte-identical;
// differing content is the theoretical ~1-in-4-billion case):
//
//   - all published (`tracked`)           -> exempt. Published files are
//        immutable (the published-migrations-immutable check), so there is
//        nothing to fix: byte-identical copies are harmless (the runner applies
//        the first by timestamp and skips the rest — same content, nothing
//        lost), and differing content is a true sha8 collision on frozen
//        history that can never be rehashed (the safety valve).
//   - all byte-identical, some branch-local -> FLAG (byte-identical): delete
//        the branch-local copies — the published one already carries the hash.
//   - differing, some branch-local        -> FLAG (differing-branch-local):
//        distinct content that can be regenerated with a fresh hash.
// ---------------------------------------------------------------------------
export type MigrationFile = { name: string; content: string; tracked: boolean };
export type MigrationGroup = { hash: string; files: MigrationFile[] };
export type CollisionKind = "byte-identical" | "differing-branch-local";
export type FlaggedCollision = {
  hash: string;
  files: string[];
  kind: CollisionKind;
};

export function classifyCollisions(
  groups: MigrationGroup[],
): FlaggedCollision[] {
  const flagged: FlaggedCollision[] = [];
  for (const { hash, files } of groups) {
    if (files.length <= 1) continue;
    if (files.every((f) => f.tracked)) continue;
    const allIdentical = files.every((f) => f.content === files[0]!.content);
    if (allIdentical) {
      flagged.push({
        hash,
        files: files.map((f) => f.name),
        kind: "byte-identical",
      });
    } else {
      flagged.push({
        hash,
        files: files.map((f) => f.name),
        kind: "differing-branch-local",
      });
    }
  }
  return flagged;
}

// A published file (`publishedMigrationBasenames`: on any `main` this checkout
// knows of) is immutable: its hash is recorded in deployed DBs'
// __singularity_migrations and it can be neither rehashed nor deleted. So only
// a group with a branch-local member is flagged, and the fix only ever touches
// branch-local files — a hint that deleted a published copy would just move
// the failure to published-migrations-immutable.

const fmtGroups = (
  cols: FlaggedCollision[],
  mark: (file: string) => string,
): string =>
  cols
    .map(
      (c) => `  ${c.hash}:\n${c.files.map((f) => `    ${mark(f)}`).join("\n")}`,
    )
    .join("\n");

const check: Check = {
  id: "migration-hashes-unique",
  description:
    "every migration filename carries a distinct sha8 (the runner's applied-state key)",
  // Not a pure function of the working tree: the published set is read from
  // the published refs via git, so fold their shas in.
  async cacheSignature(): Promise<string | null> {
    return publishedMigrationRefsSignature(await getWorktreeRoot());
  },
  async run() {
    const root = await getWorktreeRoot();
    const dir = resolve(root, MIGRATIONS_DATA_DIR);
    const tracked = await publishedMigrationBasenames(root);
    const mark = (f: string) =>
      `${f}${tracked.has(f) ? "  (published)" : "  (branch-local)"}`;

    // Group filenames by sha8. Read content only for collision groups (>1 file):
    // that is all the classifier needs to test byte-identicality.
    const namesByHash = new Map<string, string[]>();
    for (const f of readdirSync(dir)) {
      const m = MIGRATION_RE.exec(f);
      if (!m) continue;
      const list = namesByHash.get(m[3]!) ?? [];
      list.push(f);
      namesByHash.set(m[3]!, list);
    }

    const groups: MigrationGroup[] = [...namesByHash.entries()].map(
      ([hash, names]) => ({
        hash,
        files: names.map((name) => ({
          name,
          content:
            names.length > 1 ? readFileSync(join(dir, name), "utf8") : "",
          tracked: tracked.has(name),
        })),
      }),
    );

    const flagged = classifyCollisions(groups);
    if (flagged.length === 0) return { ok: true };

    const identical = flagged.filter((c) => c.kind === "byte-identical");
    const branchLocal = flagged.filter(
      (c) => c.kind === "differing-branch-local",
    );

    const messageParts: string[] = [];
    const hintParts: string[] = [];

    if (identical.length > 0) {
      messageParts.push(
        "byte-identical duplicate migrations (same sha8, identical content — the runner " +
          "applies the first by timestamp and skips the rest):\n" +
          fmtGroups(identical, mark),
      );
      hintParts.push(
        "Remove the BRANCH-LOCAL copies only — never a published one (published migrations are " +
          "immutable). A branch-local data migration (no snapshot header): delete its " +
          ".sql; `./singularity build` regenerates the journal. A branch-local schema migration: " +
          "rebase onto `main` and re-run `./singularity build --reset-migration --migration-name " +
          "<slug>`. If every copy is branch-local, keep the earliest-timestamp one.",
      );
    }

    if (branchLocal.length > 0) {
      messageParts.push(
        "branch-local migration filename hash collision (differing content that would never " +
          "run — the runner applies the first and skips the rest):\n" +
          fmtGroups(branchLocal, mark),
      );
      hintParts.push(
        "Each migration's sha8 must be unique. Custom/backfill migrations once all hashed to " +
          "the empty drizzle placeholder (b3cc75fa); renameMigrations now uniquifies the body " +
          "at generate time. Rebase onto main and re-run `./singularity build " +
          "--reset-migration --migration-name <slug>` to regenerate the branch-local migration " +
          "with a distinct hash.",
      );
    }

    return {
      ok: false,
      message: messageParts.join("\n\n"),
      hint: hintParts.join("\n\n"),
    };
  },
};

export default check;
