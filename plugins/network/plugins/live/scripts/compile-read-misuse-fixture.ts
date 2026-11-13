// The `live:read-misuse-diagnostics` probe: compiles ONE file under the repo's
// compiler options and prints its own diagnostics. A subprocess because the
// compile is tens of seconds of synchronous checker work — on the check
// runner's thread it would stall every other check for all of it.
//
// Spawned by `check/internal/read-misuse-diagnostics.ts` — a script, not check
// code: the compile runs on this process's own thread, never the check thread.
// Run as: bun compile-read-misuse-fixture.ts <root> <absFile>
// Stdin: the text to compile in place of <absFile>'s (its markers blanked —
// the file on disk is never touched).
// Emits JSON: { diagnostics: { line, code, message }[] — `line` 0-based;
// touched: { read, exists, dirs } } — every repo-relative path tsc read, asked
// the existence of, or asked whether it is a directory (outside `node_modules`,
// which the lockfile pins): the check's read-set, so its verdict replays until
// one of them moves.
import * as path from "node:path";
import ts from "typescript";

const [root, fixtureArg] = process.argv.slice(2);
if (root === undefined || fixtureArg === undefined) {
  throw new Error("usage: compile-read-misuse-fixture.ts <root> <absFile>");
}
const fixture = path.resolve(fixtureArg);
const text = await Bun.stdin.text();

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
// lockfile) is an input no fact can name: refused below, loudly. Existence and
// directory probes there (TypeScript walks up for `node_modules`) are not.
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
  // A listing is an answer no recorded fact covers; the program has one root
  // and never lists (the config parse below is handed no lister).
  throw new Error(`compile-read-misuse-fixture: tsc listed ${p}`);
};

const cfgPath = path.join(root, "tsconfig.json");
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
if (cfg.error) {
  throw new Error(
    `tsconfig.json: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, " / ")}`,
  );
}
// The options only: the program's one root is the fixture, so the files the
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
const host = ts.createCompilerHost(parsed.options, true);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
  path.resolve(fileName) === fixture
    ? ts.createSourceFile(fileName, text, languageVersion, true)
    : getSourceFile(fileName, languageVersion, onError, shouldCreate);
const readFile = host.readFile.bind(host);
host.readFile = (fileName) =>
  path.resolve(fileName) === fixture ? text : readFile(fileName);

const program = ts.createProgram({
  rootNames: [fixture],
  options: { ...parsed.options, noEmit: true },
  host,
});
const source = program.getSourceFile(fixture);
if (source === undefined) throw new Error(`${fixture} did not load`);
const diagnostics = [
  ...program.getSyntacticDiagnostics(source),
  ...program.getSemanticDiagnostics(source),
].map((d) => ({
  line: source.getLineAndCharacterOfPosition(d.start ?? 0).line,
  code: d.code,
  message: ts.flattenDiagnosticMessageText(d.messageText, " / ").slice(0, 300),
}));
if (outside.length > 0)
  throw new Error(
    `compile-read-misuse-fixture: the compile read ${outside.length} file(s) outside the repo and node_modules, which no read-set fact can key: ${outside.slice(0, 5).join(", ")}`,
  );
process.stdout.write(
  JSON.stringify({
    diagnostics,
    touched: {
      read: [...touched.read].sort(),
      exists: [...touched.exists].sort(),
      dirs: [...touched.dirs].sort(),
    },
  }),
);
