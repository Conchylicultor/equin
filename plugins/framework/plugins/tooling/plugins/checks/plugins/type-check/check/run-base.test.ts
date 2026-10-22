/**
 * The run base (research/2026-10-21-global-type-check-prepare-follows-the-change.md,
 * Stage B): a run carries every file whose state its base holds, sends the
 * worker only what changed, and records the next base. Cases:
 *   1. a base round-trips: the same tree re-run sends nothing, and the
 *      verdict is the recorded one;
 *   2. an edit sends only that file;
 *   3. a moved group fingerprint sends every file for that group only (and
 *      directive files whole);
 *   4. a removed and an added file;
 *   5. an exemption edit changes the verdict with no re-lint, including the
 *      report of a file-level exemption that suppressed nothing;
 *   6. a crashed worker records no base;
 *   7. a base missing a shard is refused: the full path, saying why;
 *   8. EQUIVALENCE — over a series of edits (a body edit, an API edit that
 *      moves an importer's result key, its revert, an add/remove, a directive
 *      file edit), the verdict and the recorded state of every file with a
 *      base equal those of the full path (an empty store).
 *
 * The worker is not spawned: a stand-in drives the worker's own decisions
 * (`../shared/lint-decisions.ts`) with a fake linter whose messages are a
 * function of each file's text, its rule group and — for a typed part — its
 * result key, so a typed result reused under the wrong key shows in the
 * verdict. Result keys are made the way the type check's are in spirit: a
 * file's own version, plus the API line of what it imports.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { LINT_DATA_FILES } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { computeTreeHash } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  LINT_GROUP_ALL,
  LINT_GROUP_BASE,
  type RawLintMessage,
  type TypedPartOutcome,
} from "../core";
import { lintResultsV3Dir, runBaseShardsDir } from "../data-dirs";
import { sha256 } from "../shared/keys";
import { createLintDecisions } from "../shared/lint-decisions";
import { openLintResultStore } from "../shared/lint-results";
import { openRepoView } from "../shared/repo-view";
import {
  loadRunBaseFiles,
  openRunBaseStore,
  type FileBase,
} from "../shared/run-base";
import {
  openPreparation,
  type Finalized,
  type Preparation,
  type ProgramOutcome,
} from "./prepare";

type Session = Extract<Preparation, { finalize: unknown }>;
type Plan = Session["plan"];

// Loading every lint contribution (to learn which groups are type-aware) and
// the TypeScript compiler is seconds on a loaded host, per data dir.
const TIMEOUT_MS = 180_000;

let root = "";
let dataRoot = "";
const scratch: string[] = [];
const priorDataRoot = process.env.SINGULARITY_DIR;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
const readRel = (rel: string): string => readFileSync(join(root, rel), "utf8");

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${code}): ${await new Response(proc.stderr).text()}`,
    );
  }
}

// Fixture paths under real plugin names: the plugin-refs check reads a
// `plugins/<x>` literal as a reference to that plugin.
const A = "plugins/shell/core/a.ts";
const B = "plugins/shell/core/b.ts";
const V = "plugins/search/core/v.ts";
const CLEAN = "plugins/search/core/clean.ts";
const D = "plugins/history/core/d.ts";
const ADDED = "plugins/search/core/added.ts";
const MANIFEST = "plugins/search/exempt/index.ts";

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "type-check-run-base-data-"));
  process.env.SINGULARITY_DIR = dataRoot;
  root = mkdtempSync(join(tmpdir(), "type-check-run-base-"));
  write(".gitignore", ".cache/\n");
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true }, include: ["plugins"] }),
  );
  write(A, "export const a = 1;\n");
  write(B, 'import { a } from "./a";\nexport const b = a + 1;\n');
  write(V, "export const v = 1; // VIOLATION TYPEDV\n");
  write(CLEAN, "export const clean = 1;\n");
  write(D, "// eslint-disable-next-line x\nexport const d = 1; // TYPEDV\n");
  write("package.json", JSON.stringify({ name: "fixture" }));
  for (const rel of LINT_DATA_FILES) write(rel, "@utility fixture {}\n");
  await git("init", "-q");
  await git("config", "core.excludesFile", "/dev/null");
});

afterAll(() => {
  if (priorDataRoot === undefined) delete process.env.SINGULARITY_DIR;
  else process.env.SINGULARITY_DIR = priorDataRoot;
  if (root) rmSync(root, { recursive: true, force: true });
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

async function prepare(): Promise<Session> {
  const treeHash = await computeTreeHash(root);
  if (treeHash === null) throw new Error(`no tree hash for ${root}`);
  const p = await openPreparation({ root, treeHash });
  if (!("finalize" in p)) throw new Error("expected a runnable plan");
  return p;
}

/** The fake linter: messages a function of the text, the group, and (typed) the key. */
function lintMessages(
  text: string,
  part:
    | { kind: "syntactic"; group: string }
    | { kind: "typed"; group: string; r: string },
  firstTyped: string,
): RawLintMessage[] {
  const m = (ruleId: string, message: string): RawLintMessage => ({
    ruleId,
    fatal: false,
    line: 1,
    column: 1,
    message,
  });
  const out: RawLintMessage[] = [];
  const syntacticHit =
    text.includes("VIOLATION") &&
    (part.group === LINT_GROUP_BASE || part.group === LINT_GROUP_ALL);
  if (part.kind === "syntactic" && syntacticHit) {
    out.push(m("x/syntactic", "syntactic"));
  }
  if (part.kind === "typed") {
    if (part.group === LINT_GROUP_ALL && text.includes("VIOLATION")) {
      out.push(m("x/syntactic", "syntactic"));
    }
    if (
      text.includes("TYPEDV") &&
      (part.group === firstTyped || part.group === LINT_GROUP_ALL)
    ) {
      out.push(m("x/typed", `typed under ${part.r.slice(0, 8)}`));
    }
  }
  return out;
}

/** What one stand-in worker run did. */
interface Worked {
  outcome: ProgramOutcome;
  /** Files whose syntactic groups ran, and whose typed parts ran. */
  syntactic: string[];
  typed: string[];
}

/**
 * Every lintable file's result key in this tree: its own version, plus — for
 * an importer of `a.ts` — the API line of `a.ts` (its first line), so a body
 * edit of `a` moves only `a`'s key and an API edit moves `b`'s too.
 */
async function resultKeys(plan: Plan): Promise<Map<string, string>> {
  const view = await openRepoView(root, plan.tree);
  const keys = new Map<string, string>();
  for (const rel of view.files()) {
    if (!rel.endsWith(".ts") || rel.endsWith(".generated.ts")) continue;
    const api = rel === B ? readRel(A).split("\n")[0]! : "";
    keys.set(rel, sha256(`${view.version(rel)}\n${api}`).slice(0, 32));
  }
  return keys;
}

/**
 * The worker, standing in: the real decisions over the plan and its base,
 * asked for every file as the type check asks (`wants` under each key), a
 * fake linter for what runs.
 */
async function work(plan: Plan): Promise<Worked> {
  const view = await openRepoView(root, plan.tree);
  const keys = await resultKeys(plan);
  const firstTyped = plan.typedParts.split[0]?.group ?? "";
  const lintStore = openLintResultStore();
  const decisions = createLintDecisions({
    lintFiles: plan.lintFiles,
    typedParts: plan.typedParts,
    base:
      plan.lintBase === null
        ? undefined
        : loadRunBaseFiles(openRunBaseStore(), plan.lintBase),
    knownTyped: (p, v) => lintStore.read(p, v)?.typed ?? [],
    version: (p) => view.version(p),
    rel: (abs) => relative(root, abs),
    abs: (p) => join(root, p),
  });
  const ran = new Map<string, TypedPartOutcome[]>();
  const typed: string[] = [];
  for (const [path, r] of keys) {
    if (!decisions.wants(path, r)) continue;
    typed.push(path);
    const text = readRel(path);
    ran.set(
      path,
      decisions.stale(path, r).map(({ group, key }) => ({
        group,
        kind: "ran",
        key,
        messages: lintMessages(text, { kind: "typed", group, r }, firstTyped),
      })),
    );
  }
  const syntactic: string[] = [];
  const { results, lintKeys } = await decisions.answer(keys, ran, (f) => {
    const rel = relative(root, f.file);
    syntactic.push(rel);
    const text = readRel(rel);
    return Promise.resolve(
      Object.fromEntries(
        f.syntactic.map((g) => [
          g,
          lintMessages(text, { kind: "syntactic", group: g }, firstTyped),
        ]),
      ),
    );
  });
  return {
    outcome: { tscClean: true, lint: results, keys: lintKeys, walkRoot: null },
    syntactic: syntactic.sort(),
    typed: typed.sort(),
  };
}

/** One whole run: prepare, the stand-in worker, finalize. */
async function run(): Promise<{
  plan: Plan;
  worked: Worked;
  done: Finalized;
}> {
  const session = await prepare();
  const worked = await work(session.plan);
  const done = await session.finalize(worked.outcome);
  return { plan: session.plan, worked, done };
}

/** The base recorded for the current tree, every file's state. */
async function recordedState(): Promise<Map<string, FileBase>> {
  const treeHash = await computeTreeHash(root);
  const store = openRunBaseStore();
  const h = store.pointer(treeHash!);
  if (h === undefined) throw new Error("no base recorded for this tree");
  return loadRunBaseFiles(store, h);
}

const sent = (plan: Plan): string[] =>
  plan.lintFiles.map((f) => relative(root, f.file)).sort();

/** Run once under a fresh, empty data dir: the full path. */
async function fullPath(): Promise<{
  done: Finalized;
  state: Map<string, FileBase>;
}> {
  const saved = process.env.SINGULARITY_DIR;
  const dir = mkdtempSync(join(tmpdir(), "type-check-run-base-full-"));
  scratch.push(dir);
  process.env.SINGULARITY_DIR = dir;
  try {
    const { plan, done } = await run();
    expect(plan.lintBase).toBeNull();
    return { done, state: await recordedState() };
  } finally {
    process.env.SINGULARITY_DIR = saved;
  }
}

test(
  "a base round-trips: the same tree sends nothing and keeps its verdict",
  async () => {
    const first = await run();
    expect(first.plan.baseLine).toContain("base none");
    expect(sent(first.plan)).toEqual([A, B, CLEAN, V, D].sort());
    expect(first.done.baseLine).toContain("written");
    expect(first.done.lintViolations).toContain(`${V}:1:1  x/syntactic`);
    expect(first.done.lintViolations).toContain(`${V}:1:1  x/typed`);
    expect(first.done.lintViolations).toContain(`${D}:1:1  x/typed`);

    const second = await run();
    expect(second.plan.baseLine).toContain("base this tree");
    expect(second.plan.lintFiles).toEqual([]);
    expect(second.plan.lintBase).not.toBeNull();
    expect(second.worked.typed).toEqual([]);
    expect(second.worked.outcome.keys).toEqual({});
    expect(second.done.lintViolations).toBe(first.done.lintViolations);
    expect(second.done.baseLine).toContain("0 rebuilt");
    expect(second.done.baseLine).toContain("kept");
  },
  TIMEOUT_MS,
);

test(
  "an edit sends only that file, and a carried importer re-lints only its typed parts when its key moves",
  async () => {
    // A body edit of a: a's key moves, b's does not.
    write(A, "export const a = 1;\n// body\n");
    const body = await run();
    expect(body.plan.baseLine).toContain("base last run");
    expect(sent(body.plan)).toEqual([A]);
    expect(body.worked.typed).toEqual([A]);

    // An API edit of a: b is carried (its text did not move), but its key
    // did — its typed parts run, its syntactic groups do not.
    write(A, "export const a: number = 2;\n// body\n");
    const api = await run();
    expect(sent(api.plan)).toEqual([A]);
    expect(api.worked.typed).toEqual([A, B]);
    expect(api.worked.syntactic).toEqual([A]);
    expect(api.done.lintLine).toContain("1 carried with a moved key");
  },
  TIMEOUT_MS,
);

test(
  "a moved group fingerprint sends every file for that group only",
  async () => {
    const before = await run();
    const typedGroups = before.plan.typedParts.split.map((p) => p.group);
    // Re-record this tree's base as if one syntactic-only group, and so the
    // directive fingerprint, had another value when it was taken.
    const store = openRunBaseStore();
    const treeHash = (await computeTreeHash(root))!;
    const base = store.root(store.pointer(treeHash)!)!;
    const group = Object.keys(base.lint.fps).find(
      (g) => !typedGroups.includes(g) && g !== LINT_GROUP_BASE,
    );
    if (group === undefined) throw new Error("no syntactic-only group");
    const forged = {
      ...base,
      lint: {
        ...base.lint,
        fps: { ...base.lint.fps, [group]: "0".repeat(16) },
        allFp: "1".repeat(16),
      },
    };
    store.setPointer(treeHash, store.putRoot(forged).hash);
    // The per-file store holds this text's results under the CURRENT
    // fingerprints too (it would answer them — the reuse it exists for), so
    // it is emptied: what is left known is the base's, under the forged ones.
    rmSync(lintResultsV3Dir.path, { recursive: true, force: true });

    const moved = await prepare();
    expect(moved.plan.baseLine).toContain(
      "rules moved (1 groups, 0 typed parts)",
    );
    expect(moved.plan.lintBase).toBeNull();
    for (const job of moved.plan.lintFiles) {
      const rel = relative(root, job.file);
      if (rel === D) {
        // A directive file is one unit: whole, its old whole key not current.
        expect(job.unit).toBe("whole");
      } else {
        expect(job.unit).toBe("split");
        expect(job.syntactic).toEqual([group]);
      }
    }
    // Every split file's typed parts stand: their keys are among the known.
    const worked = await work(moved.plan);
    expect(worked.typed).toEqual([D]);
    const done = await moved.finalize(worked.outcome);
    expect(done.lintViolations).toBe(before.done.lintViolations);
  },
  TIMEOUT_MS,
);

test(
  "a removed and an added file",
  async () => {
    rmSync(join(root, CLEAN));
    write(ADDED, "export const added = 1; // VIOLATION\n");
    const r = await run();
    expect(sent(r.plan)).toEqual([ADDED]);
    expect(r.plan.baseLine).toContain("1 changed, 1 removed");
    expect(r.done.lintViolations).toContain(`${ADDED}:1:1  x/syntactic`);
    const state = await recordedState();
    expect(state.has(CLEAN)).toBe(false);
    expect(state.has(ADDED)).toBe(true);
    // Put the fixture back for the cases below.
    rmSync(join(root, ADDED));
    write(CLEAN, "export const clean = 1;\n");
  },
  TIMEOUT_MS,
);

test(
  "an exemption edit changes the verdict and re-lints nothing it covers",
  async () => {
    const before = await run();
    expect(before.done.lintViolations).toContain(`${V}:1:1  x/syntactic`);
    // Exempt v's syntactic rule, and a file-level exemption on a clean file,
    // which suppresses nothing and is reported.
    write(
      MANIFEST,
      `export default [
  { rule: "x/syntactic", paths: ["core/v.ts", "core/clean.ts"], kind: "sanctioned", reason: "test" },
];
`,
    );
    const after = await run();
    // Only the manifest itself is new; v is carried, not re-linted.
    expect(sent(after.plan)).toEqual([MANIFEST]);
    expect(after.worked.syntactic).toEqual([MANIFEST]);
    const lines = after.done.lintViolations!.split("\n");
    expect(lines).not.toContain(`${V}:1:1  x/syntactic  syntactic`);
    expect(lines.some((l) => l.startsWith(`${V}:1:1  x/typed`))).toBe(true);
    expect(
      lines.some((l) => l.startsWith(`${CLEAN}:1:1  (unused-exemption)`)),
    ).toBe(true);
    rmSync(join(root, MANIFEST));
    rmSync(dirname(join(root, MANIFEST)), { recursive: true, force: true });
  },
  TIMEOUT_MS,
);

test(
  "a crashed worker records no base",
  async () => {
    write(A, "export const a = 3;\n");
    const session = await prepare();
    const done = await session.finalize(undefined);
    expect(done.lintViolations).toBeUndefined();
    expect(done.baseLine).toContain("not written");
    const treeHash = (await computeTreeHash(root))!;
    expect(openRunBaseStore().pointer(treeHash)).toBeUndefined();
    // The next run of the tree carries from the last completed run instead.
    const next = await run();
    expect(next.plan.baseLine).toContain("base last run");
    expect(sent(next.plan)).toEqual([A]);
  },
  TIMEOUT_MS,
);

test(
  "a base missing a shard is refused: the full path",
  async () => {
    await run();
    // Every stored shard gone (the directory also holds earlier trees'
    // shards, so removing one would not reliably hit this root's).
    const dir = runBaseShardsDir.path;
    const stored = readdirSync(dir).filter((n) => n.endsWith(".json"));
    if (stored.length === 0) throw new Error("no shard stored");
    for (const n of stored) rmSync(join(dir, n));
    const r = await prepare();
    expect(r.plan.baseLine).toMatch(/missing 3 of 3 shards — full path/);
    expect(r.plan.lintBase).toBeNull();
    expect(sent(r.plan)).toEqual([A, B, CLEAN, V, D].sort());
    // The full path's run records a whole base again: the lost shards are
    // written back (the root naming them is the same root as before).
    const done = await r.finalize((await work(r.plan)).outcome);
    expect(done.baseLine).toContain("3 rebuilt (3 new)");
    expect((await prepare()).plan.lintFiles).toEqual([]);
  },
  TIMEOUT_MS,
);

test(
  "with a base, the verdict and every file's recorded state equal the full path's, edit after edit",
  async () => {
    const steps: [string, () => void][] = [
      ["start", () => {}],
      ["body edit", () => write(A, "export const a = 1;\n// another body\n")],
      [
        "api edit",
        () => write(A, "export const a: string = 'x';\n// another body\n"),
      ],
      // Back to the body edit's API under a body never seen: a is new, and
      // b's key is the body edit's again.
      ["api revert", () => write(A, "export const a = 1;\n// a third body\n")],
      [
        "add and remove",
        () => {
          rmSync(join(root, CLEAN));
          write(ADDED, "export const added = 1; // VIOLATION TYPEDV\n");
        },
      ],
      [
        "directive edit",
        () =>
          write(
            D,
            "// eslint-disable-next-line x\nexport const d = 2; // TYPEDV VIOLATION\n",
          ),
      ],
    ];
    for (const [name, edit] of steps) {
      edit();
      const incremental = await run();
      expect(incremental.plan.lintBase, name).not.toBeNull();
      const state = await recordedState();
      const full = await fullPath();
      expect(incremental.done.lintViolations, name).toBe(
        full.done.lintViolations,
      );
      expect(Object.fromEntries(state), name).toEqual(
        Object.fromEntries(full.state),
      );
      if (name === "api revert") {
        // b's key moved back to one the per-file store already holds
        // results for: reused, not run. Only a (a new text) runs.
        expect(sent(incremental.plan), name).toEqual([A]);
        expect(incremental.worked.typed, name).toEqual([A]);
        expect(incremental.done.lintLine, name).toContain(
          "1 carried with a moved key",
        );
      }
    }
  },
  TIMEOUT_MS * 2,
);
