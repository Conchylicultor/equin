/**
 * The run base (research/2026-10-21-global-type-check-prepare-follows-the-change.md,
 * Stage B): a run carries every file whose state its base holds, sends the
 * worker only what changed, and records the next base. Cases:
 *   1. a base round-trips: the same tree re-run sends nothing, and the
 *      verdict is the recorded one;
 *   2. an edit sends only that file;
 *   3. a moved group fingerprint sends every file for that group only — and
 *      a directive file's verdict, re-combined with no program over its raw
 *      typed parts, which stand;
 *   4. a removed and an added file;
 *   5. an exemption edit changes the verdict with no re-lint, including the
 *      report of a file-level exemption that suppressed nothing;
 *   6. a crashed worker records no base;
 *   7. a base missing a shard is refused: the full path, saying why;
 *   7b. a candidate under this run's rules wins over an earlier one under
 *      other rules (a rebase onto a main whose rules moved);
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

import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
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
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

type Session = Extract<Preparation, { finalize: unknown }>;
type Plan = Session["plan"];

// Loading every lint contribution (to learn which groups are type-aware) and
// the TypeScript compiler is seconds on a loaded host, per data dir.
const TIMEOUT_MS = 180_000;

let root = asAppPath("");
let dataRoot = "";
const scratch: string[] = [];
const priorDataRoot = readEnv("DIR");

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
  setEnv("DIR", dataRoot);
  root = asAppPath(mkdtempSync(join(tmpdir(), "type-check-run-base-")));
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
  if (priorDataRoot === undefined) unsetEnv("DIR");
  else setEnv("DIR", priorDataRoot);
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

/**
 * The fake linter: messages a function of the text, the group, and (typed) the
 * key. A directive file's raw typed parts are its typed parts' messages; its
 * verdict (`combined`) is the syntactic hit plus its raw messages.
 */
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
  if (
    part.kind === "typed" &&
    text.includes("TYPEDV") &&
    part.group === firstTyped
  ) {
    out.push(m("x/typed", `typed under ${part.r.slice(0, 8)}`));
  }
  return out;
}

/** What one stand-in worker run did. */
interface Worked {
  outcome: ProgramOutcome;
  /** The paths the decisions are asked about whatever their key. */
  jobs: string[];
  /**
   * Files whose syntactic groups ran, whose typed parts ran, and whose
   * directive verdict was combined.
   */
  syntactic: string[];
  typed: string[];
  combined: string[];
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

/** The run base a plan names, as the worker reads it. */
function baseOf(plan: Plan) {
  if (plan.lintBase === null) return undefined;
  const files = loadRunBaseFiles(openRunBaseStore(), plan.lintBase.hash);
  return {
    get: (p: string) => files.get(p),
    paths: () => files.keys(),
    moved: plan.lintBase.moved,
  };
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
    base: baseOf(plan),
    knownTyped: (p, v) => {
      const e = lintStore.read(p, v);
      return { keys: e?.typed ?? [], messages: e?.messages ?? {} };
    },
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
  const combined: string[] = [];
  const { results, lintKeys } = await decisions.answer(
    keys,
    ran,
    (f) => {
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
    },
    (f, raw) => {
      const rel = relative(root, f.file);
      combined.push(rel);
      const text = readRel(rel);
      return Promise.resolve([
        ...lintMessages(
          text,
          { kind: "syntactic", group: LINT_GROUP_ALL },
          firstTyped,
        ),
        ...raw,
      ]);
    },
  );
  return {
    outcome: { tscClean: true, lint: results, keys: lintKeys, walkRoot: null },
    jobs: [...decisions.jobs].sort(),
    syntactic: syntactic.sort(),
    typed: typed.sort(),
    combined: combined.sort(),
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
  const saved = readEnv("DIR");
  const dir = mkdtempSync(join(tmpdir(), "type-check-run-base-full-"));
  scratch.push(dir);
  setEnv("DIR", dir);
  try {
    const { plan, done } = await run();
    expect(plan.lintBase).toBeNull();
    return { done, state: await recordedState() };
  } finally {
    if (saved === undefined) unsetEnv("DIR");
    else setEnv("DIR", saved);
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
    const forgedHash = store.putRoot(forged).hash;
    store.setPointer(treeHash, forgedHash);
    // No run under the current rules is left to carry from: the rules
    // pointer names the forged root too (weighed, and passed over).
    store.setRulesPointer(base.lint, { root: forgedHash, treeHash });
    // The per-file store holds this text's results under the CURRENT
    // fingerprints too (it would answer them — the reuse it exists for), so
    // it is emptied: what is left known is the base's, under the forged ones.
    rmSync(lintResultsV3Dir.path, { recursive: true, force: true });

    const moved = await prepare();
    expect(moved.plan.baseLine).toContain(
      "rules moved (1 groups, 0 typed parts)",
    );
    // The job names the base and what moved — no file's state: nothing's
    // text moved, so nothing is sent.
    expect(moved.plan.lintBase?.moved).toEqual({
      syntactic: [group],
      typed: [],
      raw: [],
      all: true,
    });
    expect(moved.plan.lintFiles).toEqual([]);
    // Every typed part stands — a directive file's raw ones too: their keys
    // are the base's. So no program lints anything, every split file runs
    // the moved group alone, and the directive file's verdict is re-combined
    // without a program.
    const worked = await work(moved.plan);
    expect(worked.typed).toEqual([]);
    expect(worked.combined).toEqual([D]);
    // ... and none needs a program: the type check keys none of them.
    expect(worked.jobs).toEqual([]);
    expect(worked.syntactic).toEqual([A, B, CLEAN, V].sort());
    for (const r of worked.outcome.lint) {
      expect(Object.keys(r.syntactic)).toEqual(
        r.unit === "split" ? [group] : [],
      );
    }
    const done = await moved.finalize(worked.outcome);
    expect(done.lintViolations).toBe(before.done.lintViolations);
    // What the moved rules re-ran is in the next base only: no per-file
    // entry is rewritten for a text the base held.
    expect(done.lintLine).toContain(`0 entries written, 5 left to the base`);
    // ... and the next run carries every file from it.
    const again = await run();
    expect(sent(again.plan)).toEqual([]);
    expect(again.done.lintViolations).toBe(before.done.lintViolations);
  },
  TIMEOUT_MS,
);

test(
  "a moved typed part re-lints every file it covers, in a program, and ships no file's state",
  async () => {
    const before = await run();
    const typedGroups = before.plan.typedParts.split.map((p) => p.group);
    const group = typedGroups[0];
    if (group === undefined) throw new Error("no type-aware group");
    // Re-record this tree's base as if one type-aware group's rules had
    // another value when it was taken: its group, typed and raw
    // fingerprints, and so the directive fingerprint, all differ.
    const store = openRunBaseStore();
    const treeHash = (await computeTreeHash(root))!;
    const base = store.root(store.pointer(treeHash)!)!;
    const forged = {
      ...base,
      lint: {
        ...base.lint,
        fps: { ...base.lint.fps, [group]: "2".repeat(16) },
        typed: { ...base.lint.typed, [group]: "3".repeat(16) },
        allFp: "4".repeat(16),
      },
    };
    const forgedHash = store.putRoot(forged).hash;
    store.setPointer(treeHash, forgedHash);
    store.setRulesPointer(base.lint, { root: forgedHash, treeHash });
    rmSync(lintResultsV3Dir.path, { recursive: true, force: true });

    const moved = await prepare();
    expect(moved.plan.baseLine).toContain(
      "rules moved (1 groups, 1 typed parts)",
    );
    expect(moved.plan.lintBase?.moved).toEqual({
      syntactic: [group],
      typed: [group],
      raw: [group],
      all: true,
    });
    expect(moved.plan.lintFiles).toEqual([]);
    const worked = await work(moved.plan);
    // Every carried file is decided — and so held by a program — and runs
    // the moved typed part (a directive file its raw one), and that one only.
    expect(worked.jobs).toEqual([A, B, CLEAN, V, D].sort());
    expect(worked.typed).toEqual(worked.jobs);
    for (const r of worked.outcome.lint) {
      expect(
        r.typed.filter((p) => p.kind === "ran").map((p) => p.group),
      ).toEqual(r.unit === "split" ? [group] : [group, LINT_GROUP_ALL]);
      expect(r.typed.filter((p) => p.kind === "cached")).toEqual([]);
    }
    expect(worked.combined).toEqual([D]);
    const done = await moved.finalize(worked.outcome);
    expect(done.lintViolations).toBe(before.done.lintViolations);
    expect(done.lintLine).toContain(
      `0 entries written, ${worked.jobs.length} left to the base`,
    );
    // The next run carries every file from the base it wrote.
    const again = await run();
    expect(sent(again.plan)).toEqual([]);
    expect(again.worked.typed).toEqual([]);
    expect(again.done.lintViolations).toBe(before.done.lintViolations);
  },
  TIMEOUT_MS,
);

test(
  "a group the base has and the rules no longer do leaves every carried file's state",
  async () => {
    const before = await run();
    expect(before.done.lintViolations).not.toContain("GONE");
    // Re-record this tree's base as if a contribution since removed had
    // linted v: its group in the base's rules, its message in v's state.
    const store = openRunBaseStore();
    const treeHash = (await computeTreeHash(root))!;
    const base = store.root(store.pointer(treeHash)!)!;
    const gone = "(a removed contribution)";
    const [id, ref] = Object.entries(base.shards).find(
      ([, r]) => store.shard(r[0])?.files[V] !== undefined,
    )!;
    const shard = store.shard(ref[0])!;
    const v = shard.files[V]!;
    const message = {
      ruleId: "gone/rule",
      fatal: false,
      line: 1,
      column: 1,
      message: "GONE",
    };
    const patched = store.putShard({
      files: {
        ...shard.files,
        [V]: { ...v, s: { ...v.s, [gone]: [message] } },
      },
    }).hash;
    const forged = {
      ...base,
      lint: {
        ...base.lint,
        fps: { ...base.lint.fps, [gone]: "5".repeat(16) },
        allFp: "6".repeat(16),
      },
      shards: {
        ...base.shards,
        [id]: [patched, ref[1], 1, ref[3]] as typeof ref,
      },
    };
    const forgedHash = store.putRoot(forged).hash;
    store.setPointer(treeHash, forgedHash);
    store.setRulesPointer(base.lint, { root: forgedHash, treeHash });

    const moved = await prepare();
    expect(moved.plan.lintBase?.moved).toEqual({
      syntactic: [],
      typed: [],
      raw: [],
      all: true,
    });
    expect(moved.plan.lintFiles).toEqual([]);
    const worked = await work(moved.plan);
    expect(worked.syntactic).toEqual([]);
    expect(worked.typed).toEqual([]);
    expect(worked.combined).toEqual([D]);
    const done = await moved.finalize(worked.outcome);
    expect(done.lintViolations).toBe(before.done.lintViolations);
    expect((await recordedState()).get(V)?.s?.[gone]).toBeUndefined();
  },
  TIMEOUT_MS,
);

test(
  "with no candidate tree under this run's rules, the latest run under them is the base",
  async () => {
    const before = await run();
    const store = openRunBaseStore();
    const treeHash = (await computeTreeHash(root))!;
    const current = store.root(store.pointer(treeHash)!)!;
    // This tree's own base is under other rules (a worktree whose last run
    // predates the rules it now has); the rules pointer still names the
    // current root, as a sibling's run under these rules would have left it.
    const forged = {
      ...current,
      lint: { ...current.lint, allFp: "2".repeat(16) },
    };
    store.setPointer(treeHash, store.putRoot(forged).hash);
    rmSync(lintResultsV3Dir.path, { recursive: true, force: true });

    const r = await run();
    expect(r.plan.baseLine).toContain("base same rules");
    expect(r.plan.baseLine).toContain("this tree");
    expect(r.plan.baseLine).toContain("other rules");
    expect(sent(r.plan)).toEqual([]);
    expect(r.done.lintViolations).toBe(before.done.lintViolations);
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
  "a candidate under this run's rules wins over the last run under other rules",
  async () => {
    // HEAD's tree gets a base under the current rules (as main's does, from
    // the pusher's check of that very tree).
    await git("add", "-A");
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "-m",
      "head",
    );
    await run();
    // The worktree's last run is of another tree, under other rules: what a
    // run before a rebase onto a main whose rules moved leaves behind.
    write(A, "export const a = 4;\n");
    await run();
    const store = openRunBaseStore();
    const lastTree = (await computeTreeHash(root))!;
    const base = store.root(store.pointer(lastTree)!)!;
    const forged = {
      ...base,
      lint: {
        ...base.lint,
        fps: Object.fromEntries(
          Object.keys(base.lint.fps).map((g) => [g, "0".repeat(16)]),
        ),
        allFp: "1".repeat(16),
      },
    };
    store.setPointer(lastTree, store.putRoot(forged).hash);

    write(B, 'import { a } from "./a";\nexport const b = a + 2;\n');
    const r = await prepare();
    // HEAD's base carries every file but the two that differ from it; the
    // last run's would have sent every file.
    expect(r.plan.baseLine).toContain("base HEAD");
    expect(r.plan.baseLine).toMatch(/passed over last run \w+: other rules/);
    expect(r.plan.baseLine).not.toContain("rules moved");
    expect(r.plan.lintBase).not.toBeNull();
    expect(sent(r.plan)).toEqual([A, B].sort());
    await r.finalize((await work(r.plan)).outcome);
    // Put the fixture back for the cases below.
    write(A, "export const a = 3;\n");
    write(B, 'import { a } from "./a";\nexport const b = a + 1;\n');
  },
  TIMEOUT_MS,
);

test(
  "a base missing a shard is refused: the full path",
  async () => {
    await run();
    // Every stored shard gone (the directory also holds earlier trees'
    // shards, so removing one would not reliably hit this root's).
    const gens = join(runBaseShardsDir.path, "generations");
    const stored = readdirSync(gens)
      .filter((g) => /^g\d+$/.test(g))
      .flatMap((g) =>
        readdirSync(join(gens, g))
          .filter((n) => n.endsWith(".json"))
          .map((n) => join(gens, g, n)),
      );
    if (stored.length === 0) throw new Error("no shard stored");
    for (const f of stored) rmSync(f);
    const r = await prepare();
    expect(r.plan.baseLine).toMatch(/base none \(.*missing 3 of 3 shards/);
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
