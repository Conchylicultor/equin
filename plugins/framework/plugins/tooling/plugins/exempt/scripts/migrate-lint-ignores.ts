/**
 * One-shot migration: every `ignores:` key of a `plugins/**\/lint/index.ts`
 * barrel becomes `exempt/index.ts` manifest entries (owner = the plugin that
 * owns the file), `outOfScope` categories, or `closed` rule ids.
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/exempt/scripts/migrate-lint-ignores.ts [--apply] [--debt-task <id>]
 *
 * Without --apply it prints the plan only. Leading comments of an entry become
 * its `reason` (a comment applies to the entries after it until the next one);
 * the output is meant to be hand-curated.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { globToRegExp, type FileCategory } from "../core/file-category";

const apply = process.argv.includes("--apply");
const taskIdx = process.argv.indexOf("--debt-task");
const debtTask = taskIdx === -1 ? "TODO-TASK" : process.argv[taskIdx + 1]!;

const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });

const tracked = sh("git", ["ls-files", "-co", "--exclude-standard"])
  .split("\n")
  .filter(Boolean)
  .filter((f) => fs.existsSync(f));
const barrels = tracked.filter((f) => /^plugins\/.*\/lint\/index\.ts$/.test(f));

const CATEGORY_GLOBS: Record<string, FileCategory> = {
  "**/*.test.ts": "test",
  "**/*.test.tsx": "test",
  "**/*.test.{ts,tsx}": "test",
  "**/__tests__/**": "test",
  "**/__tests__/**/*.ts": "test",
  "**/__tests__/**/*.tsx": "test",
  "**/testing/**": "test",
  "**/e2e/**": "e2e",
  "**/scripts/**": "script",
  "**/bin/**": "bin",
  "**/cli/**": "cli",
  "**/central/**": "central",
  "**/provision/**": "provision",
  "research/**": "research",
};

const DIR_SUFFIX =
  /\/(?:\*\*(?:\/\*(?:\.(?:\{ts,tsx\}|tsx?))?)?|\*(?:\.(?:\{ts,tsx\}|tsx?))?)$/;
const hasGlob = (s: string) => /[*{?[]/.test(s);

/** Owner = the nearest plugin dir; path relative to it ("." for the dir). */
function ownerOf(p: string): { owner: string; rel: string } | undefined {
  const seg = p.split("/");
  let i = 0;
  const parts: string[] = [];
  while (seg[i] === "plugins" && seg[i + 1]) {
    parts.push("plugins", seg[i + 1]!);
    i += 2;
  }
  if (parts.length === 0) return undefined;
  return { owner: parts.join("/"), rel: seg.slice(i).join("/") || "." };
}

type Resolved =
  | { kind: "category"; category: FileCategory }
  | { kind: "paths"; paths: string[] }
  | { kind: "dead" }
  | { kind: "manual"; why: string };

function resolveGlob(g: string): Resolved {
  const norm = g.startsWith("**/") ? g.replace(DIR_SUFFIX, "/**") : g;
  const cat =
    CATEGORY_GLOBS[norm] ??
    (g.startsWith("**/") && /\.test\.(ts|tsx|\{ts,tsx\})$/.test(g)
      ? "test"
      : undefined);
  if (cat) return { kind: "category", category: cat };
  let base = g;
  if (base.startsWith("**/plugins/")) base = base.slice(3);
  if (base.startsWith("plugins/")) {
    const dir = base.replace(DIR_SUFFIX, "");
    if (!hasGlob(dir)) {
      if (dir !== base) {
        return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
          ? { kind: "paths", paths: [dir] }
          : { kind: "dead" };
      }
      return fs.existsSync(base)
        ? { kind: "paths", paths: [base] }
        : { kind: "dead" };
    }
  }
  let re: RegExp;
  try {
    re = globToRegExp(g);
  } catch (e) {
    return { kind: "manual", why: String(e) };
  }
  const paths = tracked.filter((f) => re.test(f));
  return paths.length > 0 ? { kind: "paths", paths } : { kind: "dead" };
}

function cleanComment(raw: string): string {
  return raw
    .replace(/^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/+|\*+)\s?/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isSatisfiesExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isParenthesizedExpression(e)
  )
    e = e.expression;
  return e;
}

const propName = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ? p.name.text
    : undefined;

interface ManifestEntry {
  rule: string;
  paths: Set<string>;
  reason: string;
  kind: "sanctioned" | "debt";
}
const manifests = new Map<string, Map<string, ManifestEntry>>();
const dead: string[] = [];
const manual: string[] = [];
let entryCount = 0;
let outOfScopeCount = 0;
let closedCount = 0;

const stringsOf = (e: ts.Expression | undefined): string[] =>
  e && ts.isArrayLiteralExpression(e)
    ? e.elements.filter(ts.isStringLiteralLike).map((s) => s.text)
    : [];

for (const file of barrels) {
  const text = fs.readFileSync(file, "utf8");
  if (!/\bignores\b/.test(text)) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const exp = sf.statements.find(ts.isExportAssignment);
  if (!exp) continue;
  const obj = unwrap(exp.expression);
  if (!ts.isObjectLiteralExpression(obj)) continue;
  const ignoresProp = obj.properties.find((p) => propName(p) === "ignores");
  if (!ignoresProp || !ts.isPropertyAssignment(ignoresProp)) continue;
  const nameProp = obj.properties.find((p) => propName(p) === "name");
  const ns =
    nameProp &&
    ts.isPropertyAssignment(nameProp) &&
    ts.isStringLiteral(nameProp.initializer)
      ? nameProp.initializer.text
      : "?";
  const enfProp = obj.properties.find(
    (p) => propName(p) === "enforceEverywhere",
  );
  const enforce = new Set(
    stringsOf(
      enfProp && ts.isPropertyAssignment(enfProp)
        ? unwrap(enfProp.initializer)
        : undefined,
    ),
  );

  const ignores = unwrap(ignoresProp.initializer);
  if (!ts.isObjectLiteralExpression(ignores)) {
    manual.push(`${file}: ignores is not an object literal`);
    continue;
  }
  const outOfScope: Record<string, Set<FileCategory>> = {};
  const closed: string[] = [];

  for (const rp of ignores.properties) {
    const rule = propName(rp);
    if (!rule || !ts.isPropertyAssignment(rp)) {
      manual.push(`${file}: unreadable ignores key`);
      continue;
    }
    const arr = unwrap(rp.initializer);
    if (!ts.isArrayLiteralExpression(arr)) {
      manual.push(`${file}: ${rule} not an array literal`);
      continue;
    }
    if (arr.elements.length === 0) {
      closed.push(rule);
      closedCount++;
      continue;
    }
    let current = (ts.getLeadingCommentRanges(text, rp.getFullStart()) ?? [])
      .map((c) => cleanComment(text.slice(c.pos, c.end)))
      .join(" ");
    for (const el of arr.elements) {
      if (!ts.isStringLiteralLike(el)) {
        manual.push(`${file}: ${rule} non-string element`);
        continue;
      }
      const cs = ts.getLeadingCommentRanges(text, el.getFullStart()) ?? [];
      if (cs.length > 0)
        current = cs
          .map((c) => cleanComment(text.slice(c.pos, c.end)))
          .join(" ");
      entryCount++;
      const r = resolveGlob(el.text);
      if (r.kind === "dead") {
        dead.push(`${file}: ${rule}: ${el.text}`);
        continue;
      }
      if (r.kind === "manual") {
        manual.push(`${file}: ${rule}: ${el.text}: ${r.why}`);
        continue;
      }
      if (r.kind === "category") {
        if (
          (r.category === "test" || r.category === "e2e") &&
          !enforce.has(rule)
        )
          continue; // already out of scope by default
        (outOfScope[rule] ??= new Set()).add(r.category);
        continue;
      }
      const liveRule = ns === "live" && rule === "no-legacy-resource-spelling";
      const isDebt = liveRule && !el.text.endsWith("/**");
      if (liveRule)
        current = isDebt
          ? "Burndown: imported an old live-resource spelling when phase 3 started and still depends on the tree resource (item 3). New code declares, serves and reads through network/live; delete this entry when the file migrates."
          : "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).";
      for (const p of r.paths) {
        const o = ownerOf(p);
        if (!o) {
          manual.push(`${file}: ${rule}: ${p}: no owning plugin`);
          continue;
        }
        const m = manifests.get(o.owner) ?? new Map<string, ManifestEntry>();
        manifests.set(o.owner, m);
        const key = `${ns}/${rule}\0${isDebt}\0${current}`;
        const me: ManifestEntry = m.get(key) ?? {
          rule: `${ns}/${rule}`,
          paths: new Set<string>(),
          reason: current,
          kind: isDebt ? "debt" : "sanctioned",
        };
        me.paths.add(o.rel);
        m.set(key, me);
      }
    }
  }
  for (const s of Object.values(outOfScope)) outOfScopeCount += s.size;

  // ---- rewrite the barrel ----
  const lit = (xs: readonly string[]) =>
    xs.map((x) => JSON.stringify(x)).join(", ");
  const newProps: string[] = [];
  const oos = Object.entries(outOfScope);
  if (oos.length > 0)
    newProps.push(
      `outOfScope: {\n${oos
        .map(([r, s]) => `    ${JSON.stringify(r)}: [${lit([...s])}],`)
        .join("\n")}\n  },`,
    );
  if (closed.length > 0) newProps.push(`closed: [${lit(closed)}],`);
  const start = ignoresProp.getStart();
  let end = ignoresProp.getEnd();
  if (text[end] === ",") end++;
  const edits: { pos: number; end: number; text: string }[] = [
    { pos: start, end, text: newProps.join("\n  ") },
  ];
  if (!ts.isSatisfiesExpression(exp.expression)) {
    edits.push({
      pos: exp.expression.getEnd(),
      end: exp.expression.getEnd(),
      text: " satisfies LintContribution",
    });
    const importLine =
      'import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";';
    const lastImport = [...sf.statements].filter(ts.isImportDeclaration).pop();
    if (lastImport)
      edits.push({
        pos: lastImport.getEnd(),
        end: lastImport.getEnd(),
        text: "\n" + importLine,
      });
    else edits.push({ pos: 0, end: 0, text: importLine + "\n" });
  }
  if (apply) {
    let out = text;
    for (const e of edits.sort((a, b) => b.pos - a.pos))
      out = out.slice(0, e.pos) + e.text + out.slice(e.end);
    fs.writeFileSync(file, out);
  }
}

// ---- manifests ----
const q = (s: string) => JSON.stringify(s);
for (const [owner, m] of [...manifests].sort()) {
  const file = path.join(owner, "exempt/index.ts");
  const entries = [...m.values()].map((e) => {
    const reason = e.reason || "TODO-REASON";
    const paths = [...e.paths].sort();
    return [
      "  {",
      `    rule: ${q(e.rule)},`,
      `    paths: [${paths.map(q).join(", ")}],`,
      `    kind: ${q(e.kind)},`,
      ...(e.kind === "debt" ? [`    task: ${q(debtTask)},`] : []),
      `    reason:\n      ${q(reason)},`,
      "  },",
    ].join("\n");
  });
  const body = entries.join("\n");
  console.log(`${file}: ${m.size} entries`);
  if (!apply) continue;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, "utf8");
    const i = cur.lastIndexOf("] satisfies Exemptions");
    if (i === -1) throw new Error(`${file}: cannot merge`);
    fs.writeFileSync(file, cur.slice(0, i) + body + "\n" + cur.slice(i));
  } else {
    fs.writeFileSync(
      file,
      `import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";\n\nexport default [\n${body}\n] satisfies Exemptions;\n`,
    );
  }
}

console.log(
  `\nignores entries seen: ${entryCount}; manifests: ${manifests.size}; outOfScope: ${outOfScopeCount}; closed: ${closedCount}`,
);
console.log(`\nDEAD (${dead.length}):\n${dead.join("\n")}`);
console.log(`\nMANUAL (${manual.length}):\n${manual.join("\n")}`);
