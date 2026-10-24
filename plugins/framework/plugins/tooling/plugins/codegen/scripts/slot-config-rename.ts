/**
 * One-shot migration: move each reorderable slot's config files from the
 * hand-authored slot id they were named by to the derived declaration key.
 *
 *   config/<plugin path>/studio.sidebar.jsonc  ->  config/<plugin path>/sidebar.jsonc
 *
 * The git layer was migrated in the same commit that dropped the `id` parameter
 * from the slot constructors. THIS script remains for the USER layer
 * (`~/.singularity/config/<worktree>/…`), which no commit can carry — run it
 * once, by hand, at land time:
 *
 *   bun <this file>            # dry run over every worktree's user config
 *   bun <this file> --apply
 *
 * It reads the rename table as COMMITTED DATA rather than deriving it. The old
 * ids exist nowhere in the source any more — deriving them would mean reading a
 * manifest that has since been regenerated — so the table is the only durable
 * record of the mapping. Delete both once every worktree has been migrated.
 *
 * Do not copy this shape for a plugin move: `./equin plugin move` records
 * the move in relocate's ledger, and every build migrates its own namespace
 * (`applyPluginMoves`) — no hand-run step.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "fs";
import { join } from "path";
import { configDir } from "@plugins/config_v2/data-dirs";

interface Move {
  hier: string;
  from: string;
  to: string;
}

const VARIANTS = ["", ".origin", ".ancestor"] as const;

// Resolved from THIS file: plugins/framework/plugins/tooling/plugins/codegen/scripts/
// → up 6 to `plugins/`, then reorder's shared dir.
const TABLE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "reorder/shared/slot-id-rename.json",
);

function loadTable(): Move[] {
  return JSON.parse(readFileSync(TABLE, "utf-8")) as Move[];
}

/** Assert before moving anything: a refused run leaves the tree untouched. */
function assertSafe(rootDir: string, moves: readonly Move[]): void {
  const problems: string[] = [];
  const targets = new Set<string>();
  for (const m of moves) {
    const key = `${m.hier}/${m.to}`;
    if (targets.has(key)) problems.push(`two slots both target ${key}`);
    targets.add(key);
    const dir = join(rootDir, m.hier);
    if (!existsSync(dir)) continue; // this worktree never had that plugin's config
    if (!statSync(dir).isDirectory()) {
      problems.push(`${m.hier} is not a directory`);
      continue;
    }
    for (const v of VARIANTS) {
      const src = join(dir, `${m.from}${v}.jsonc`);
      const dst = join(dir, `${m.to}${v}.jsonc`);
      if (existsSync(src) && existsSync(dst)) {
        problems.push(`both ${m.from}${v} and ${m.to}${v} exist in ${m.hier}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[rename] refusing to move anything:\n  ${problems.join("\n  ")}`,
    );
  }
}

function applyMoves(rootDir: string, moves: readonly Move[]): number {
  let moved = 0;
  for (const m of moves) {
    for (const v of VARIANTS) {
      const src = join(rootDir, m.hier, `${m.from}${v}.jsonc`);
      const dst = join(rootDir, m.hier, `${m.to}${v}.jsonc`);
      // Absent source ⇒ nothing to carry (or already migrated). Never a failure:
      // a user layer holds only the descriptors that worktree actually touched.
      if (!existsSync(src) || existsSync(dst)) continue;
      renameSync(src, dst);
      moved++;
    }
  }
  return moved;
}

const apply = process.argv.includes("--apply");
const moves = loadTable();
console.log(`${moves.length} slot(s) in the rename table.`);

let total = 0;
for (const worktree of readdirSync(configDir.path)) {
  const rootDir = join(configDir.path, worktree);
  if (!statSync(rootDir).isDirectory()) continue;
  assertSafe(rootDir, moves);
  const present = moves.filter((m) =>
    VARIANTS.some((v) =>
      existsSync(join(rootDir, m.hier, `${m.from}${v}.jsonc`)),
    ),
  ).length;
  if (present === 0) continue;
  if (!apply) {
    console.log(`  ${worktree}: ${present} slot(s) to migrate`);
    total += present;
    continue;
  }
  const n = applyMoves(rootDir, moves);
  console.log(`  ${worktree}: moved ${n} file(s)`);
  total += n;
}
console.log(
  apply
    ? `\nMoved ${total} file(s).`
    : `\nDry run — ${total} slot(s) would migrate. Re-run with --apply.`,
);
