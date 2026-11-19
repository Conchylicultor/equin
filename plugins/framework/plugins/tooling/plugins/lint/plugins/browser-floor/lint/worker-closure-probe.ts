// The `browser-floor:worker-closure` probe: runs `no-api-above-floor` on the
// modules a browser host's worker loads that lint does not already cover (its
// `server/` and `bin/` files), with types, under the repo's compiler options.
// A subprocess because the compile is seconds of synchronous checker work — on
// the check runner's thread it would stall every other check for all of it.
//
// Spawned by `../check/index.ts` — a script, not check code: it sits beside
// the rule because it runs the rule itself (a leaf folder is never imported
// from another folder), and is never imported by `./index.ts`.
// Run as: bun worker-closure-probe.ts <root>
// Stdin: JSON `{ modules: string[] }` — the worker closure, repo-relative.
// Emits JSON: { checked: string[]; violations: { file, line, column, message }[];
// touched: { read, exists, dirs } } — every repo-relative path tsc read, asked
// the existence of, or asked whether it is a directory (outside
// `node_modules`, which the lockfile pins): the check's read-set.
import * as path from "node:path";
import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import ts from "typescript";
import { isBrowserBuilt } from "./browser-built";
import rule from "./no-api-above-floor";

const [root] = process.argv.slice(2);
if (root === undefined) {
  throw new Error("usage: worker-closure-probe.ts <root>");
}
const { modules } = JSON.parse(await Bun.stdin.text()) as {
  modules: string[];
};

/** The plugin and rule name the rule runs under, as in the repo's lint config. */
const RULE_ID = "browser-floor/no-api-above-floor";

// The worker's modules lint does not already hold to the floor: everything
// outside the browser-built folders (in practice `server/` and the host's
// `bin/`), TypeScript only.
const checked = modules
  .filter((m) => /\.tsx?$/.test(m) && !isBrowserBuilt(m, root))
  .sort();

// Every file-system question the compile asks, recorded where every part of
// it (the config parse, module resolution, source reads) asks it: `ts.sys`,
// wrapped BEFORE any host is made (a host binds some of its methods at
// creation).
const touched = {
  read: new Set<string>(),
  exists: new Set<string>(),
  dirs: new Set<string>(),
};
const inRepo = (p: string): string | null => {
  const r = path.relative(root, path.resolve(p)).split(path.sep).join("/");
  return r.startsWith("..") ||
    path.isAbsolute(r) ||
    r.split("/").includes("node_modules")
    ? null
    : r;
};
const sys = ts.sys;
const note =
  <A extends unknown[], R>(set: Set<string>, fn: (p: string, ...a: A) => R) =>
  (p: string, ...a: A): R => {
    const r = inRepo(p);
    if (r !== null) set.add(r);
    return fn.call(sys, p, ...a);
  };
// A file READ outside the repo and outside `node_modules` (pinned by the
// lockfile) is an input no fact can name: refused below, loudly.
const outside: string[] = [];
const isNpm = (p: string): boolean =>
  path.resolve(p).split(path.sep).includes("node_modules");
const sysReadFile = sys.readFile;
sys.readFile = (p, encoding) => {
  if (inRepo(p) === null && !isNpm(p)) outside.push(p);
  return note(touched.read, sysReadFile)(p, encoding);
};
sys.fileExists = note(touched.exists, sys.fileExists);
sys.directoryExists = note(touched.dirs, sys.directoryExists);
sys.getDirectories = note(touched.dirs, sys.getDirectories);
sys.readDirectory = (p) => {
  // A listing is an answer no recorded fact covers; the program's roots are
  // given and the config parse below is handed no lister.
  throw new Error(`worker-closure-probe: tsc listed ${p}`);
};

const cfgPath = path.join(root, "tsconfig.json");
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
if (cfg.error) {
  throw new Error(
    `tsconfig.json: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, " / ")}`,
  );
}
// The options only: the roots are the checked files, so the files the
// config's `include` would list (a walk of the whole repo) are never used.
const parsed = ts.parseJsonConfigFileContent(
  cfg.config,
  {
    useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
    fileExists: sys.fileExists,
    readFile: sys.readFile,
    readDirectory: () => [],
  },
  root,
  undefined,
  cfgPath,
);
const program = ts.createProgram({
  rootNames: checked.map((m) => path.join(root, m)),
  options: { ...parsed.options, noEmit: true },
  host: ts.createCompilerHost(parsed.options, true),
});

const linter = new Linter({ configType: "flat" });
const config: Linter.Config[] = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser as Linter.Parser,
      parserOptions: { programs: [program] },
    },
    plugins: {
      "browser-floor": {
        rules: { "no-api-above-floor": rule as never },
      },
    },
    rules: { [RULE_ID]: ["error", { shipsToBrowser: true }] },
  },
];

const violations: {
  file: string;
  line: number;
  column: number;
  message: string;
}[] = [];
for (const m of checked) {
  const abs = path.join(root, m);
  const source = program.getSourceFile(abs);
  if (source === undefined) throw new Error(`${m} did not load`);
  for (const msg of linter.verify(source.text, config, abs)) {
    // Only the rule's own answers and a parse failure: another rule's
    // directive in the file names a rule this config does not load.
    if (msg.ruleId !== RULE_ID && !msg.fatal) continue;
    violations.push({
      file: m,
      line: msg.line,
      column: msg.column,
      message: msg.message,
    });
  }
}
if (outside.length > 0)
  throw new Error(
    `worker-closure-probe: the compile read ${outside.length} file(s) outside the repo and node_modules, which no read-set fact can key: ${outside.slice(0, 5).join(", ")}`,
  );
process.stdout.write(
  JSON.stringify({
    checked,
    violations,
    touched: {
      read: [...touched.read].sort(),
      exists: [...touched.exists].sort(),
      dirs: [...touched.dirs].sort(),
    },
  }),
);
