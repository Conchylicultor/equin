// Replays main's first-parent history and counts the commits that move the
// npm part of the type check's global hash — the whole lockfile's resolutions
// plus every type-visible patch (`tscEngineFp`, `../shared/tsc-engine.ts`) —
// against an NPM SCOPE: the lock closure of the packages the program can see
// (the npm specifiers the tree's files name, their `@types/` twins, the
// tsconfig's `types`, the JSX runtime, and what their declarations load). A
// move of either re-checks every file and re-runs every typed lint part, in
// every worktree that rebases onto it.
//
// The scope was built and measured on 2026-11-08 and NOT landed: it would
// have saved one whole-tree re-check in four weeks
// (research/2026-11-08-global-tsc-npm-scope.md). This script is the evidence,
// and the instrument to re-measure before trying again.
//
// Each tree's specifiers are read as the worker reads them (`fileImports`
// over every root of the tsconfig's include), counted per specifier and
// updated from one commit to the next by the files that changed. Not packages:
// node builtins, and names matched by HEAD's ambient module patterns. The
// packages declarations load beyond the lock's graph (mermaid's `type-fest`,
// a devDependency reached through bun's hoisted fallback) are measured once,
// by an environment program over this checkout's install, and applied to
// every commit.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/npm-scope-replay.ts [--since 2026-10-09]

import { createHash } from "crypto";
import ts from "typescript";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { lockfileNpmClosure } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-closure/core";
import { lockfileNpmResolutions } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-resolutions/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { parse } from "jsonc-parser";
import { builtinModules } from "module";
import { dirname, join } from "path";
import { fileImports } from "../shared/name-check";
import { typeVisiblePatch } from "../shared/tsc-engine";

const root: string = REPO_ROOT;
const since = (() => {
  const i = process.argv.indexOf("--since");
  return i < 0 ? "2026-10-09" : process.argv[i + 1]!;
})();
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

async function git(...args: string[]): Promise<string> {
  const r = await spawnCaptured(["git", "-C", root, ...args], {
    unbounded: "a one-off replay script; git reads of local objects",
  });
  if (r.exitCode !== 0 && !(args[0] === "grep" && r.exitCode === 1)) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  return r.stdout;
}

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  root,
);
const options = config.options;

// ── The scope's pieces ──

/** What npm accepts as a package name (legacy capitals included). */
const PACKAGE_NAME = /^(@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/;
const BUILTINS = new Set(builtinModules);
/** HEAD's ambient module patterns (`declare module "@browser-host/*"`): a specifier they match names no package. */
const ambient: RegExp[] = [];

/** The npm package a specifier names, or undefined: a path, a `paths` alias, a builtin, an ambient name, no package name. */
function specifierPackage(spec: string): string | undefined {
  if (spec.startsWith(".") || spec.startsWith("/")) return undefined;
  if (BUILTINS.has(spec) || BUILTINS.has(`node:${spec}`)) return undefined;
  if (ambient.some((re) => re.test(spec))) return undefined;
  for (const pattern of Object.keys(options.paths ?? {})) {
    const star = pattern.indexOf("*");
    if (star < 0 ? spec === pattern : spec.startsWith(pattern.slice(0, star))) {
      return undefined;
    }
  }
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return PACKAGE_NAME.test(name) ? name : undefined;
}

const npmSpecifiers = (specs: Iterable<string>): string[] =>
  [
    ...new Set([...specs].filter((s) => specifierPackage(s) !== undefined)),
  ].sort();

/** The scope's roots: each named package with its `@types/` twin, the `types` entries, the JSX runtime. */
function npmRoots(imported: Iterable<string>): string[] {
  const out = new Set<string>();
  const add = (p: string): void => {
    out.add(p);
    out.add(
      p.startsWith("@types/")
        ? p
        : `@types/${p.startsWith("@") ? p.slice(1).replace("/", "__") : p}`,
    );
  };
  for (const t of options.types ?? []) add(t);
  for (const p of imported) add(p);
  add(options.jsxImportSource ?? "react");
  return [...out].sort();
}

/** The package a file under `node_modules` belongs to. */
function pathPackage(fileName: string): string | undefined {
  const parts = fileName.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const first = parts[at + 1]!;
  return first.startsWith("@") ? `${first}/${parts[at + 2] ?? ""}` : first;
}

/** The package name of each lock key a closure reached (its last segment). */
const closureNames = (entries: readonly string[]): string[] =>
  entries.map((e) => {
    const key = e.split("\0")[0]!.split("/");
    const scoped = key.length >= 2 && key[key.length - 2]!.startsWith("@");
    return scoped ? key.slice(-2).join("/") : key[key.length - 1]!;
  });

/**
 * The npm packages tsc loads declarations of for these specifiers, over this
 * checkout's install: one program (built, not checked) whose virtual roots
 * import them from the root, and from each workspace the ones whose package it
 * declares (bun's isolated install puts those in its own node_modules).
 */
function envPackages(specifiers: readonly string[], lock: string): string[] {
  const workspaces = (
    parse(lock, [], { allowTrailingComma: true }) as {
      workspaces: Record<
        string,
        Record<string, Record<string, string> | string>
      >;
    }
  ).workspaces;
  const imports = (specs: readonly string[]): string =>
    specs.map((s) => `import ${JSON.stringify(s)};`).join("\n");
  const virtual = new Map<string, string>([
    [
      join(root, "__npm-scope__.ts"),
      imports([...specifiers, "react/jsx-runtime"]),
    ],
  ]);
  for (const [dir, w] of Object.entries(workspaces)) {
    if (dir === "") continue;
    const declared = new Set(
      [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ].flatMap((k) =>
        Object.keys((w[k] as Record<string, string> | undefined) ?? {}),
      ),
    );
    const here = specifiers.filter((s) => declared.has(specifierPackage(s)!));
    if (here.length > 0)
      virtual.set(join(root, dir, "__npm-scope__.ts"), imports(here));
  }
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => {
    const text = virtual.get(name);
    return text !== undefined
      ? ts.createSourceFile(name, text, lang)
      : getSourceFile(name, lang, ...rest);
  };
  host.fileExists = (name) => virtual.has(name) || fileExists(name);
  host.readFile = (name) => virtual.get(name) ?? readFile(name);
  const program = ts.createProgram({
    rootNames: [...virtual.keys()],
    options: { ...options, noEmit: true },
    host,
  });
  const libDir = dirname(ts.getDefaultLibFilePath(options));
  const out = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.startsWith(libDir)) continue;
    const pkg = pathPackage(sf.fileName);
    if (pkg !== undefined) out.add(pkg);
  }
  return [...out].sort();
}

/** A root of the tsconfig's include: every tracked `.ts`/`.tsx` under plugins/, test/, or a root `*.config.ts`. */
const isRoot = (p: string): boolean =>
  /\.tsx?$/.test(p) &&
  !p.split("/").includes("node_modules") &&
  (p.startsWith("plugins/") ||
    p.startsWith("test/") ||
    /^[^/]*\.config\.ts$/.test(p));

async function specsAt(commit: string, path: string): Promise<string[]> {
  const text = await git("show", `${commit}:${path}`);
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const specs = fileImports(sf, options).map(([spec]) => spec);
  if (path.endsWith(".d.ts")) {
    for (const r of sf.typeReferenceDirectives) specs.push(r.fileName);
  }
  return npmSpecifiers(specs);
}

/** Per specifier, the files naming it — kept from commit to commit. */
const counts = new Map<string, number>();
const fileSpecs = new Map<string, string[]>();
const bump = (specs: readonly string[], by: number): void => {
  for (const s of specs) {
    const n = (counts.get(s) ?? 0) + by;
    if (n === 0) counts.delete(s);
    else counts.set(s, n);
  }
};
async function setFile(commit: string, path: string): Promise<void> {
  bump(fileSpecs.get(path) ?? [], -1);
  fileSpecs.delete(path);
  const specs = await specsAt(commit, path);
  fileSpecs.set(path, specs);
  bump(specs, 1);
}
function dropFile(path: string): void {
  bump(fileSpecs.get(path) ?? [], -1);
  fileSpecs.delete(path);
}
const packagesNamed = (): string[] =>
  [...new Set([...counts.keys()].map((s) => specifierPackage(s)!))].sort();

// HEAD's ambient module patterns, then what declarations load beyond the
// lock's graph, from this checkout's install.
{
  const decls = (await git("ls-tree", "-r", "--name-only", "HEAD"))
    .trim()
    .split("\n")
    .filter((p) => isRoot(p) && p.endsWith(".d.ts"));
  for (const d of decls) {
    for (const m of (await git("show", `HEAD:${d}`)).matchAll(
      /^declare module "([^"]*\*[^"]*)"/gm,
    )) {
      const [pre, post] = m[1]!.split("*") as [string, string];
      const esc = (x: string): string =>
        x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      ambient.push(new RegExp(`^${esc(pre)}.*${esc(post)}$`));
    }
  }
}
{
  const files = (await git("ls-tree", "-r", "--name-only", "HEAD"))
    .trim()
    .split("\n")
    .filter(isRoot);
  for (const f of files) await setFile("HEAD", f);
}
const hereSpecs = [...counts.keys()].sort();
const lockNow = readFileSync(join(root, "bun.lock"), "utf8");
const loadedNow = envPackages(hereSpecs, lockNow);
const named = closureNames(
  lockfileNpmClosure(lockNow, npmRoots(packagesNamed())).entries,
);
const beyond = loadedNow.filter((p) => !named.includes(p));
console.log(
  `HEAD: ${hereSpecs.length} specifiers, ${packagesNamed().length} packages named; loaded beyond the lock's graph: ${beyond.join(", ") || "none"}`,
);
counts.clear();
fileSpecs.clear();

const commits = (
  await git(
    "rev-list",
    "--first-parent",
    "--reverse",
    `--since=${since}`,
    "main",
  )
)
  .trim()
  .split("\n");
let prevCommit: string | undefined;
let prevPkgs: string[] = [];
let prevOld = "";
let prevNew = "";
let oldMoves = 0;
let newMoves = 0;
const rows: string[] = [];
for (const c of commits) {
  const lock = await git("show", `${c}:bun.lock`);
  const patchList = (
    await git("ls-tree", "-r", "--name-only", c, "--", "patches")
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const patches = new Map<string, string>();
  for (const p of patchList) patches.set(p, await git("show", `${c}:${p}`));
  const oldKey = sha(
    [
      sha(lockfileNpmResolutions(lock)),
      ...[...patches]
        .filter(([, t]) => typeVisiblePatch(t, options))
        .map(([p, t]) => `${p} ${sha(t)}`),
    ].join("\n"),
  );
  if (prevCommit === undefined) {
    const files = (await git("ls-tree", "-r", "--name-only", c))
      .trim()
      .split("\n")
      .filter(isRoot);
    for (const f of files) await setFile(c, f);
  } else {
    const diff = (
      await git("diff", "--name-status", "--no-renames", prevCommit, c)
    ).trim();
    for (const line of diff === "" ? [] : diff.split("\n")) {
      const [status, path] = line.split("\t") as [string, string];
      if (!isRoot(path)) continue;
      if (status === "D") dropFile(path);
      else await setFile(c, path);
    }
  }
  prevCommit = c;
  const pkgs = packagesNamed();
  const named = npmRoots(pkgs);
  const closure = lockfileNpmClosure(lock, [...named, ...beyond]);
  const newKey = sha(
    [
      ...closure.entries,
      ...closure.missing.map((m) => `missing\0${m}`),
      ...closure.patches.flatMap((p) => {
        const t = patches.get(p);
        if (t === undefined) return [`absent ${p}`];
        return typeVisiblePatch(t, options) ? [`patch ${p} ${sha(t)}`] : [];
      }),
    ].join("\n"),
  );
  const o = prevOld !== "" && oldKey !== prevOld;
  const n = prevNew !== "" && newKey !== prevNew;
  if (o) oldMoves++;
  if (n) newMoves++;
  if (o || n) {
    const subject = (await git("log", "-1", "--format=%cs %s", c))
      .trim()
      .slice(0, 90);
    const added = pkgs.filter((p) => !prevPkgs.includes(p));
    const dropped = prevPkgs.filter((p) => !pkgs.includes(p));
    const names =
      added.length + dropped.length > 0
        ? ` [names ${[...added.map((p) => `+${p}`), ...dropped.map((p) => `-${p}`)].join(" ")}]`
        : "";
    rows.push(
      `${c.slice(0, 10)}  old ${o ? "MOVES" : "-    "}  new ${n ? "MOVES" : "-    "}  ${subject.slice(0, 60)}${names}`,
    );
  }
  prevOld = oldKey;
  prevPkgs = pkgs;
  prevNew = newKey;
}
console.log(rows.join("\n"));
console.log(
  `\n${commits.length} first-parent commits on main since ${since}: the whole-lockfile key moved ${oldMoves} times, the npm scope ${newMoves} times`,
);
