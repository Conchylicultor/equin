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
// Emits JSON: { line, code, message }[] — `line` 0-based.
import * as path from "node:path";
import ts from "typescript";

const [root, fixtureArg] = process.argv.slice(2);
if (root === undefined || fixtureArg === undefined) {
  throw new Error("usage: compile-read-misuse-fixture.ts <root> <absFile>");
}
const fixture = path.resolve(fixtureArg);
const text = await Bun.stdin.text();

const cfgPath = path.join(root, "tsconfig.json");
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
if (cfg.error) {
  throw new Error(
    `tsconfig.json: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, " / ")}`,
  );
}
const parsed = ts.parseJsonConfigFileContent(
  cfg.config,
  ts.sys,
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
process.stdout.write(JSON.stringify(diagnostics));
