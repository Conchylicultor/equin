// ─── Does the typed lint key ever miss a change? ─────────────────────────────
//
//   ./singularity run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/typed-key-oracle.ts \
//     snapshot <checkout> <out.json>
//   ./singularity run …/typed-key-oracle.ts compare <before.json> <after.json>
//
// The type fingerprint (`../shared/type-fingerprint.ts`) claims that a file
// whose fingerprint did not move sees the same types it saw before, so its
// cached typed lint result stands. This checks the claim against the checker
// itself, on two real trees.
//
// `snapshot` builds a checkout's program cold, with the worker's own emit
// options, and records for every repo file (a) its type fingerprint, computed
// exactly as the worker computes it (contract edges read off the declarations
// this build emitted), and (b) a DIGEST of what a type-aware rule can observe
// in it: for every identifier, its type as text (never truncated) with, one
// level down, its properties' types and its call signatures, and the files
// declaring its symbol; for every call, the resolved signature; for every
// function and object literal, its contextual type. `compare` reports every
// file whose own text is unchanged and whose digest changed while its
// fingerprint did not — a MISS, a cached typed result that would be wrong —
// and how many fingerprints moved for nothing (over-invalidation, the cost
// side). A file whose text changed is skipped: its result key moves with the
// text. Exit 1 on any miss.
//
// Manual and expensive: a cold program build plus a type walk over ~11.7k
// files per snapshot (minutes, ~15 GB). It is the correctness gate for a
// change to the key, not part of any check.

import { readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { createHash } from "crypto";
import ts from "typescript";
import {
  contractEdges,
  contractSpecifiers,
  canonical,
  type ContractSpecifiers,
} from "../shared/contract-refs";
import { signatureEmitOptions } from "../shared/emit-options";
import {
  computeTypeFingerprints,
  isRepoPath,
  readBuildInfoGraph,
} from "../shared/type-fingerprint";

interface Snapshot {
  root: string;
  /** Repo-relative path → type fingerprint. */
  fps: Record<string, string>;
  /** Repo-relative path → digest of what a typed rule can observe. */
  digests: Record<string, string>;
  /** Repo-relative path → hash of its own text (a changed text is its own key). */
  texts: Record<string, string>;
}

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

function digestFile(
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  root: string,
  shapes: Map<ts.Type, string>,
  dump?: (line: string) => void,
): string {
  const sha = createHash("sha256");
  const h = {
    update(line: string): void {
      sha.update(line);
      dump?.(line);
    },
  };
  const flags =
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;
  // A type as a rule can observe it: its printed name is not enough — an
  // interface prints as its name whatever its members are — so it is its text
  // plus, one level down, every property's type and every call signature.
  const typeText = (t: ts.Type | undefined): string => {
    if (t === undefined) return "-";
    let text = shapes.get(t);
    if (text === undefined) {
      const props = checker
        .getPropertiesOfType(checker.getApparentType(t))
        .map(
          (p) =>
            // A unique-symbol key prints as `__@name@<symbol id>`, and the id is
            // creation order: dropped, or every edit anywhere would show here.
            `${p.name.replace(/^(__@.*)@\d+$/, "$1")}${p.flags & ts.SymbolFlags.Optional ? "?" : ""}:${checker.typeToString(checker.getTypeOfSymbol(p), undefined, flags)}`,
        )
        .sort();
      const calls = t
        .getCallSignatures()
        .map((sig) => checker.signatureToString(sig, undefined, flags));
      text = `${checker.typeToString(t, undefined, flags)}{${props.join(";")}}(${calls.join(";")})`;
      shapes.set(t, text);
    }
    return text;
  };
  const visit = (node: ts.Node): void => {
    const at = node.getStart(sf);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaredIn = (symbol?.declarations ?? [])
        .map((d) => rel(root, d.getSourceFile().fileName))
        .sort()
        .join(",");
      h.update(
        `i${at}:${typeText(checker.getTypeAtLocation(node))}|${symbol?.flags ?? "-"}|${declaredIn}\n`,
      );
    } else if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isJsxOpeningLikeElement(node)
    ) {
      const sig = checker.getResolvedSignature(node);
      h.update(
        `c${at}:${sig === undefined ? "-" : checker.signatureToString(sig, undefined, flags)}\n`,
      );
    } else if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isObjectLiteralExpression(node)
    ) {
      h.update(`x${at}:${typeText(checker.getContextualType(node))}\n`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sha.digest("hex").slice(0, 16);
}

function snapshot(root: string, out: string, dumpFiles?: Set<string>): void {
  const tsconfigPath = join(root, "tsconfig.json");
  const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (cfg.error) throw new Error("tsconfig did not parse");
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    root,
    undefined,
    tsconfigPath,
  );
  // Laid out where the worker's buildinfo lives, so its relative paths read
  // the same; cold, so nothing from an earlier build leaks in.
  const buildInfoPath = join(
    root,
    ".cache",
    "tsbuildinfo",
    "oracle.tsbuildinfo",
  );
  rmSync(buildInfoPath, { force: true });
  try {
    const options = signatureEmitOptions(parsed.options, root, buildInfoPath);
    const builder = ts.createIncrementalProgram({
      rootNames: parsed.fileNames,
      options,
    });
    const errors = ts.getPreEmitDiagnostics(builder.getProgram()).length;
    let buildInfoText: string | undefined;
    const emitted = new Map<string, ContractSpecifiers>();
    builder.emit(undefined, (fileName, text, _bom, _onError, sourceFiles) => {
      if (fileName.endsWith(".tsbuildinfo")) buildInfoText = text;
      else if (/\.d\.[mc]?ts$/.test(fileName) && sourceFiles?.length === 1) {
        emitted.set(
          canonical(rel(root, sourceFiles[0]!.fileName)),
          contractSpecifiers(text),
        );
      }
    });
    if (buildInfoText === undefined) throw new Error("tsc wrote no buildinfo");
    const r = readBuildInfoGraph(buildInfoText, dirname(buildInfoPath), root);
    if (r.kind !== "graph") throw new Error(r.why);
    const memo = new Map<string, ContractSpecifiers>();
    const { contracts, summary } = contractEdges(
      root,
      builder.getProgram(),
      options,
      r.graph,
      emitted,
      {
        read: (p, sig) => memo.get(`${p}\0${sig}`),
        record: (p, sig, refs) => void memo.set(`${p}\0${sig}`, refs),
      },
    );
    const fps = Object.fromEntries(computeTypeFingerprints(r.graph, contracts));
    console.log(`${root}: ${errors} tsc diagnostics; ${summary}`);

    const program = builder.getProgram();
    const checker = program.getTypeChecker();
    const digests: Record<string, string> = {};
    const texts: Record<string, string> = {};
    const shapes = new Map<ts.Type, string>();
    for (const sf of program.getSourceFiles()) {
      const p = rel(root, sf.fileName);
      if (!isRepoPath(p)) continue;
      digests[p] = digestFile(
        checker,
        sf,
        root,
        shapes,
        dumpFiles?.has(p)
          ? (line) => process.stdout.write(`${p} ${line}`)
          : undefined,
      );
      texts[p] = createHash("sha256")
        .update(sf.text)
        .digest("hex")
        .slice(0, 16);
    }
    const snap: Snapshot = { root, fps, digests, texts };
    writeFileSync(out, JSON.stringify(snap));
    console.log(`wrote ${Object.keys(digests).length} files to ${out}`);
  } finally {
    rmSync(buildInfoPath, { force: true });
  }
}

function compare(beforePath: string, afterPath: string): number {
  const a = JSON.parse(readFileSync(beforePath, "utf8")) as Snapshot;
  const b = JSON.parse(readFileSync(afterPath, "utf8")) as Snapshot;
  // Compare by canonical path: two checkouts of one repo, one spelling per file.
  const keyed = (s: Snapshot, f: "fps" | "digests" | "texts") =>
    new Map(Object.entries(s[f]).map(([p, v]) => [canonical(p), v] as const));
  const [fa, fb, da, db, ta, tb] = [
    keyed(a, "fps"),
    keyed(b, "fps"),
    keyed(a, "digests"),
    keyed(b, "digests"),
    keyed(a, "texts"),
    keyed(b, "texts"),
  ];
  const misses: string[] = [];
  let moved = 0;
  let movedForNothing = 0;
  let digestChanged = 0;
  for (const [p, before] of fa) {
    const after = fb.get(p);
    const dA = da.get(p);
    const dB = db.get(p);
    if (after === undefined || dA === undefined || dB === undefined) continue;
    if (ta.get(p) !== tb.get(p)) continue;
    const fpMoved = before !== after;
    const seen = dA !== dB;
    if (fpMoved) moved++;
    if (seen) digestChanged++;
    if (fpMoved && !seen) movedForNothing++;
    if (!fpMoved && seen) misses.push(p);
  }
  console.log(
    `${fa.size} files: ${moved} fingerprints moved, ${digestChanged} digests changed, ` +
      `${movedForNothing} moved with no observable change, ${misses.length} MISSES`,
  );
  for (const p of misses.slice(0, 50)) console.log(`  miss: ${p}`);
  return misses.length === 0 ? 0 : 1;
}

const [mode, x, y] = process.argv.slice(2);
if (mode === "snapshot" && x && y) {
  snapshot(x, y);
} else if (mode === "dump" && x && y) {
  // Every digest line of the named files (comma-separated), for diffing two
  // trees when `compare` reports a file it cannot explain.
  snapshot(x, "/dev/null", new Set(y.split(",")));
} else if (mode === "compare" && x && y) {
  process.exit(compare(x, y));
} else {
  console.error(
    "usage: typed-key-oracle.ts snapshot <checkout> <out.json> | compare <before.json> <after.json>",
  );
  process.exit(2);
}
