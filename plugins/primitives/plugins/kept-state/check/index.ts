import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import { schemaStamp } from "@plugins/primitives/plugins/dom/plugins/web-storage/core";
import { keptWorkDeclarations } from "../core";

/** The ref whose schemas the deployed tabs were built from. */
const MAIN = "main";

type Declared = { owner: string; stamp: string | null; line: number };

const DECLARATION = /\bdefineKept(<[^>]*>)?\(\{/;

/** `<field>: "<literal>"` inside a declaration's text. */
function field(text: string, name: string): string | null {
  return new RegExp(`\\b${name}:\\s*"([^"]*)"`).exec(text)?.[1] ?? null;
}

/**
 * The work-tier `defineKept({...})` declarations of one file's source, read
 * statically — the same way on this checkout and on main's blob, so main's
 * stamps are read without evaluating main. A declaration runs to the first
 * line closing the call; its owner, tier and stamp are literals.
 */
function workDeclarations(text: string): Declared[] {
  const lines = text.split("\n");
  const out: Declared[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
    if (!DECLARATION.test(line)) continue;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j] ?? "");
      if (j > i && /^\s*\}\)/.test(lines[j] ?? "")) break;
    }
    const decl = body.join("\n");
    if (field(decl, "tier") !== "work") continue;
    const owner = field(decl, "owner");
    if (owner === null) continue; // budget-fits names a non-literal owner
    out.push({ owner, stamp: field(decl, "stamp"), line: i + 1 });
  }
  return out;
}

/** A local git read: object lookups, never the network. */
const GIT_TIMEOUT_MS = 30_000;

async function git(root: string, args: string[]): Promise<string> {
  const r = await spawnCaptured(["git", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  // `git grep` exits 1 when nothing matches.
  const nothingMatched =
    args[0] === "grep" && r.exitCode === 1 && r.stderr === "";
  if (r.exitCode !== 0 && !nothingMatched)
    throw new Error(
      `git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.trim()}`,
    );
  return r.stdout;
}

/** Each work owner's stamp literal as main declares it. */
async function mainStamps(
  root: string,
  inScope: (path: string) => boolean,
): Promise<Map<string, string>> {
  const listed = await git(root, [
    "grep",
    "-l",
    "-E",
    "defineKept",
    MAIN,
    "--",
    "*.ts",
    "*.tsx",
  ]);
  const paths = listed
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.slice(MAIN.length + 1))
    .filter(inScope);
  const stamps = new Map<string, string>();
  const texts = await Promise.all(
    paths.map((p) => git(root, ["show", `${MAIN}:${p}`])),
  );
  for (const text of texts)
    for (const d of workDeclarations(text))
      if (d.stamp !== null) stamps.set(d.owner, d.stamp);
  return stamps;
}

/**
 * An upgrade reload reads work the previous build wrote. web-storage leaves
 * an entry another schema wrote unread (`other-schema`), so a work owner whose
 * schema changed since main would hide every draft on the upgrade — unless it
 * declares a `migrate` entry for main's stamp. This check holds that: each
 * work owner's `stamp` literal is its schema's real stamp (imported and
 * computed here), and a stamp that differs from main's has a migration from
 * it. View-tier state is exempt: dropping it is acceptable.
 */
const check: Check = {
  id: "kept-state:work-schema-migrates",
  description:
    "Every kept-state work owner's `stamp` literal is its schema's stamp, and a schema changed since main declares `migrate` for main's stamp — so an upgrade reload does not hide a draft",
  outOfScope: ["test", "e2e", "research"],
  // The verdict reads main's blobs, which the tree hash does not cover.
  async cacheSignature() {
    const root = await getWorktreeRoot();
    return (await git(root, ["rev-parse", MAIN])).trim();
  },
  async run(ctx) {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: DECLARATION,
      grepArg: "defineKept",
      maskStrings: true,
    });
    const files = [
      ...new Set(matches.map((m) => m.path).filter((p) => ctx.inScope(p))),
    ].sort();
    const problems: string[] = [];
    const declared: (Declared & { path: string })[] = [];
    for (const path of files) {
      const text = await readFile(join(root, path), "utf8");
      for (const d of workDeclarations(text)) declared.push({ ...d, path });
    }
    if (declared.length === 0) return { ok: true };

    // Evaluate the declaring modules: defineKept records each work owner's
    // schema and migrations as it runs.
    registerBarrelStubs(root);
    for (const path of new Set(declared.map((d) => d.path))) {
      try {
        await importBarrel(join(root, path));
      } catch (err) {
        problems.push(`${path}: failed to import: ${String(err)}`);
      }
    }
    const recorded = keptWorkDeclarations();
    const onMain = await mainStamps(root, (p) => ctx.inScope(p));

    for (const d of declared) {
      const at = `${d.path}:${d.line}`;
      const rec = recorded.get(d.owner);
      if (!rec) {
        if (!problems.some((p) => p.startsWith(`${d.path}:`)))
          problems.push(
            `${at}: work owner "${d.owner}" was not declared when its module was imported`,
          );
        continue;
      }
      const actual = schemaStamp(rec.schema);
      if (d.stamp !== actual)
        problems.push(
          `${at}: work owner "${d.owner}" must declare \`stamp: "${actual}"\` (its schema's stamp${d.stamp === null ? "" : `; it says "${d.stamp}"`})`,
        );
      const prior = onMain.get(d.owner);
      if (
        prior !== undefined &&
        prior !== actual &&
        !rec.migrateFrom.includes(prior)
      )
        problems.push(
          `${at}: work owner "${d.owner}"'s schema changed since main (stamp "${prior}" → "${actual}") with no \`migrate\` entry for "${prior}" — an upgrade reload would hide every draft main's build wrote`,
        );
    }

    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n    "),
      hint: 'Set `stamp` to the value named. For a changed schema add `migrate: { "<main\'s stamp>": (old) => <a value of the new schema> }` to the defineKept call — `(old) => old` when the old value still parses (an added optional field). See plugins/primitives/plugins/kept-state/CLAUDE.md § Across builds.',
    };
  },
};

export default check;
