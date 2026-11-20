/**
 * Measurement 2 of the design "a list entry without its plugin's code"
 * (wiki: Import time and lazy imports): how many of the places that read a web
 * list directly touch a CODE field of its entries — the size of the edit stage
 * 3 (code on use) would make, since a reader of facts cannot hold code.
 *
 *   ./equin run plugins/framework/plugins/list-catalog/scripts/measure-fact-readers.ts [--list]
 *
 * How: every file calling `.useContributions()` (the direct read of a web
 * list) is type-checked twice in memory, in one TypeScript program over the
 * repo's tsconfig — once as it is, once with web-sdk's `Slot.useContributions`
 * re-typed to return the list's FACTS (`Fact<P>`, list-catalog: every code
 * field gone) instead of its sealed contributions. Nothing is written: the
 * second program reads a patched copy of `web-sdk/core/slots.ts` from memory.
 * The new diagnostics are the places that touch code; they are counted per
 * call site, per file and per error code. `--list` prints each.
 *
 * Limits: a read through `useRawContributions` (untyped, the framework
 * primitives' read) is not re-typed and not counted — it is listed apart; a
 * reader that passes the list on to a helper in ANOTHER file errors there,
 * which is counted only when that file also reads a list directly.
 */
import { join } from "path";
import ts from "typescript";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const root = asAppPath(process.cwd());
const showList = process.argv.includes("--list");
const SLOTS = join(root, "plugins/framework/plugins/web-sdk/core/slots.ts");
const ORIGINAL =
  "useContributions: Hook<() => readonly SealContributions<P>[]>;";
const PATCHED =
  'useContributions: Hook<() => readonly (import("@plugins/framework/plugins/list-catalog/core").Fact<P> & import("./sealed-component").SealedMeta)[]>;';

// The readers: every non-test source calling `.useContributions(` / the raw read.
const readers: string[] = [];
const rawReaders: string[] = [];
let callSites = 0;
for (const rel of [...(await loadRepoFiles(root)).all()].sort()) {
  if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) continue;
  if (/\.test\.tsx?$|\/__tests__\/|\/testing\//.test(rel)) continue;
  const text = await readFile(join(root, rel), "utf8");
  const n = text.match(/\.useContributions\(\)/g)?.length ?? 0;
  if (n > 0 && !rel.startsWith("plugins/framework/plugins/web-sdk/")) {
    readers.push(rel);
    callSites += n;
  }
  if (/useRawContributions\(/.test(text)) rawReaders.push(rel);
}

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  root,
);
const slotsText = await readFile(SLOTS, "utf8");
if (!slotsText.includes(ORIGINAL)) {
  throw new Error(
    `measure-fact-readers: web-sdk's Slot.useContributions is no longer typed as \`${ORIGINAL}\` — update the patch`,
  );
}

function diagnostics(patch: boolean, old?: ts.Program) {
  const host = ts.createCompilerHost(parsed.options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, lang, onError, create) =>
    patch && fileName === SLOTS
      ? ts.createSourceFile(
          fileName,
          slotsText.replace(ORIGINAL, PATCHED),
          lang,
        )
      : getSourceFile(fileName, lang, onError, create);
  const program = ts.createProgram({
    rootNames: readers.map((r) => join(root, r)),
    options: parsed.options,
    host,
    oldProgram: old,
  });
  const out = new Set<string>();
  const rows: { key: string; code: number; text: string }[] = [];
  for (const rel of readers) {
    const sf = program.getSourceFile(join(root, rel));
    if (sf === undefined)
      throw new Error(`measure-fact-readers: ${rel} not in the program`);
    for (const d of program.getSemanticDiagnostics(sf)) {
      const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
      const key = `${rel}:${line + 1}`;
      const text = ts
        .flattenDiagnosticMessageText(d.messageText, " ")
        .slice(0, 160);
      const id = `${key} TS${d.code} ${text}`;
      if (out.has(id)) continue;
      out.add(id);
      rows.push({ key, code: d.code, text });
    }
  }
  return { program, rows };
}

const t0 = performance.now();
const before = diagnostics(false);
const after = diagnostics(true, before.program);
const known = new Set(before.rows.map((r) => `${r.key} ${r.code} ${r.text}`));
const added = after.rows.filter(
  (r) => !known.has(`${r.key} ${r.code} ${r.text}`),
);

const sites = new Set(added.map((r) => r.key));
const files = new Set(added.map((r) => r.key.replace(/:\d+$/, "")));
const byCode = new Map<number, number>();
for (const r of added) byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);

console.log(
  `readers of a web list (non-test files calling .useContributions()): ${readers.length} files, ${callSites} call sites`,
);
console.log(
  `files reading the raw, untyped list (useRawContributions; not re-typed): ${rawReaders.length}`,
);
console.log(
  `with facts instead of contributions: ${added.length} new errors at ${sites.size} lines in ${files.size} files ` +
    `(${files.size} of ${readers.length} reading files touch a code field; baseline errors in these files: ${before.rows.length})`,
);
console.log(
  `by code: ${[...byCode]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `TS${c} ×${n}`)
    .join(", ")}`,
);
console.log(
  `(two programs, ${((performance.now() - t0) / 1000).toFixed(0)} s)`,
);
if (showList)
  for (const r of added) console.log(`  ${r.key} TS${r.code} ${r.text}`);
