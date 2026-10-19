// The keyed type check: tsc's diagnostics and signatures, re-computed only for
// the files whose KEY moved — the same type fingerprint that keys typed lint
// (`./type-fingerprint.ts`), so one key decides both.
//
// Why not TypeScript's own incremental builder: when a file's signature
// changes, TS 6's builder walks every TRANSITIVE referencer of it, without
// asking whether their own signatures changed
// (`handleDtsMayChangeOfReferencingExportOfAffectedFile`). So an exported-type
// edit in a hub re-checked ~96 CPU-s of the repo, as much as a cold build, and
// re-emitted all ~11.9k declarations. What a file's check reads is narrower:
// its own text, the `.d.ts` of what it imports and of everything those name,
// the global scope, and the engine. That is exactly the type fingerprint, so
//
//   key(f) = H( f's path and version, typeFp(f) )
//
// and a file whose key is in the store is not checked: its diagnostics, its
// signature (the hash of its `.d.ts`) and the specifiers its `.d.ts` names come
// from the store, and its importers' keys follow from them. A file whose key
// moved is checked and emitted, and its new signature feeds its importers' keys
// — so the walk stops wherever a contract stops changing.
//
// THE WALK. Each importer's key needs its imports' final signatures, so files
// are visited in dependency order: the strongly-connected components of the
// SOURCE graph, every component after the ones it reaches (Tarjan's order).
// Contract components nest inside source components (a `.d.ts` names only what
// its source can reach), so once a source component's members have their
// signatures, their contract hashes are final too. A source cycle is keyed and
// checked as ONE unit: its members' versions, plus each member's type
// fingerprint over the references that leave the cycle — coarser than per file
// (a body edit re-checks the cycle), and sound.
//
// THE STORE is host-global and content-addressed (`./file-results-store.ts`):
// a key names the same answer in every worktree, so a fresh worktree on a
// main tree is warm without any incremental base to pick.
//
// SOUNDNESS rests on the claim above, and two hazards are known: a diagnostic
// can depend on the order the checker reached things (closed for signatures by
// `stableTypeOrdering`), and checking one file can file an error under another.
// Both are what the dual mode measures — the walk next to a full check of a
// fresh program, compared file by file (`compareResults`) — and what the daily
// backstop on main keeps measuring. See
// research/2026-10-18-global-tsc-recheck-follows-contracts.md.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";
import { z } from "zod";
// Through the barrel: the worker imports it the same way (a deep import into
// the plugin's own `core/` is what the browser build cannot inline).
import type { TscDivergence } from "../core";
import {
  contractResolver,
  contractSpecifiers,
  contractSpecifiersSchema,
} from "./contract-refs";
import { lockfileLintDigest } from "./lockfile";
import { programGraph } from "./program-graph";
import {
  forEachComponent,
  globalHash,
  hashComponents,
  isRepoPath,
  needsContract,
  sha256,
  typeFpOf,
  type Contract,
  type ProgramGraph,
} from "./type-fingerprint";

/** What checking one file gives: all a later run needs in its place. */
export const fileResultSchema = z.object({
  /** The hash of its emitted `.d.ts` and declaration diagnostics. */
  signature: z.string(),
  /** What its `.d.ts` names (`./contract-refs.ts`). */
  specs: contractSpecifiersSchema,
  /** Its semantic and declaration diagnostics, formatted. */
  diagnostics: z.array(z.string()),
});

export type FileResult = z.infer<typeof fileResultSchema>;

/** One checked unit's stored results, by repo-relative path. */
export type UnitResults = Record<string, FileResult>;

/** Where checked results live: per unit key, host-wide in the worker. */
export interface FileResultsLookup {
  read(key: string): UnitResults | undefined;
  record(key: string, results: UnitResults): void;
}

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

export function formatDiagnostic(root: string, d: ts.Diagnostic): string {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${rel(root, d.file.fileName)}:${line + 1}:${character + 1} - error TS${d.code}: ${msg}`;
  }
  return `error TS${d.code}: ${msg}`;
}

/**
 * The ENGINE every key folds in (through the global hash): what decides a
 * file's diagnostics besides its own text and the declarations it sees. The
 * compiler and its options (paths relative to the root, so every worktree
 * shares one key), the npm resolutions (`lockfileLintDigest`: a contract edge
 * into a dependency is dropped, so a dependency's own types move every key
 * through here), dependency patches, and this engine's own code.
 */
export function tscEngineFp(root: string, options: ts.CompilerOptions): string {
  const parts: string[] = [`typescript ${ts.version}`];
  parts.push(
    `options ${JSON.stringify(options, (_k, v: unknown) =>
      typeof v === "string" && v.startsWith(root)
        ? `<root>${v.slice(root.length)}`
        : v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            )
          : v,
    )}`,
  );
  const lock = join(root, "bun.lock");
  parts.push(
    `lock ${existsSync(lock) ? lockfileLintDigest(readFileSync(lock, "utf8")) : "-"}`,
  );
  const patches = join(root, "patches");
  if (existsSync(patches)) {
    for (const entry of readdirSync(patches, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .sort()) {
      parts.push(
        `patch ${rel(root, entry)} ${sha256(readFileSync(entry, "utf8"))}`,
      );
    }
  }
  for (const own of ENGINE_SOURCES) {
    parts.push(
      `source ${own} ${sha256(readFileSync(join(import.meta.dir, own), "utf8"))}`,
    );
  }
  return sha256(parts.join("\n"));
}

/** This engine's code: what decides a key, a check, and a signature. */
const ENGINE_SOURCES = [
  "keyed-check.ts",
  "program-graph.ts",
  "type-fingerprint.ts",
  "contract-refs.ts",
  "emit-options.ts",
  "lockfile.ts",
];

/**
 * A `.d.ts` in a canonical form: every type literal's PROPERTY signatures in
 * name order, and every union's members in text order. tsc's printed order is
 * not always a function of the code, even with `stableTypeOrdering`: it
 * orders unions of anonymous object types, and the properties normalization
 * adds to them (`task?: undefined`), by what the checker had resolved before.
 * Measured: 11 of 12k files printed differently checked in walk order vs tsc's
 * order, and 6 more over 31 replayed main commits. A property's position in a
 * type literal, and a member's in a union, mean nothing, so sorting them only
 * removes the noise; method and call signatures keep their relative order, and
 * intersections theirs, since overload resolution reads both.
 */
export function canonicalDeclarations(dts: string): string {
  const sf = ts.createSourceFile(
    "contract.d.ts",
    dts,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter();
  const nameOf = (m: ts.PropertySignature): string =>
    ts.isIdentifier(m.name) ||
    ts.isStringLiteral(m.name) ||
    ts.isNumericLiteral(m.name)
      ? m.name.text
      : printer.printNode(ts.EmitHint.Unspecified, m.name, sf);
  const sortMembers: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node): ts.Node => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isUnionTypeNode(visited)) {
        const types = visited.types
          .map((t) => ({
            t,
            text: printer.printNode(ts.EmitHint.Unspecified, t, sf),
          }))
          .sort((x, y) => (x.text < y.text ? -1 : x.text > y.text ? 1 : 0))
          .map(({ t }) => t);
        return context.factory.updateUnionTypeNode(
          visited,
          context.factory.createNodeArray(types),
        );
      }
      if (!ts.isTypeLiteralNode(visited)) return visited;
      const props = visited.members
        .filter(ts.isPropertySignature)
        .map((m) => ({ m, name: nameOf(m) }))
        .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
        .map(({ m }) => m);
      const rest = visited.members.filter((m) => !ts.isPropertySignature(m));
      return context.factory.updateTypeLiteralNode(
        visited,
        context.factory.createNodeArray([...rest, ...props]),
      );
    };
    return (root) => ts.visitNode(root, visit) as ts.SourceFile;
  };
  const result = ts.transform(sf, [sortMembers]);
  const text = printer.printFile(result.transformed[0]!);
  result.dispose();
  return text;
}

/**
 * `program.emit` with its sixth parameter, `forceDtsEmit` — a TypeScript
 * internal (the builder passes it to compute a signature): without it a file
 * whose declaration emit reports a diagnostic emits no `.d.ts`, and its
 * signature could not be computed. The parameter is typed here, once; a
 * compiler that drops it emits nothing for such a file, and `checkFile`
 * throws.
 */
function emitWithForcedDts(
  program: ts.Program,
): (
  targetSourceFile: ts.SourceFile,
  writeFile: ts.WriteFileCallback,
  cancellationToken: undefined,
  emitOnlyDtsFiles: true,
  customTransformers: undefined,
  forceDtsEmit: true,
) => ts.EmitResult {
  return program.emit.bind(program) as never;
}

/**
 * Check one repo source file: its semantic and declaration diagnostics, and
 * its `.d.ts` — forced even when a declaration diagnostic would block it, the
 * way tsc's builder computes a signature — whose hash (canonical form), with
 * those diagnostics, is the signature.
 */
export function checkFile(
  root: string,
  program: ts.Program,
  sf: ts.SourceFile,
): FileResult {
  const semantic = program.getSemanticDiagnostics(sf);
  const declaration = program.getDeclarationDiagnostics(sf);
  let dts: string | undefined;
  emitWithForcedDts(program)(
    sf,
    (fileName, text) => {
      if (/\.d\.[mc]?ts$/.test(fileName)) dts = text;
    },
    undefined,
    /*emitOnlyDtsFiles*/ true,
    undefined,
    /*forceDtsEmit*/ true,
  );
  if (dts === undefined) {
    throw new Error(
      `type-check: emitting ${rel(root, sf.fileName)}'s declaration produced no .d.ts`,
    );
  }
  const declLines = declaration.map((d) => formatDiagnostic(root, d));
  return {
    signature: sha256(`${canonicalDeclarations(dts)}\n${declLines.join("\n")}`),
    specs: contractSpecifiers(dts),
    diagnostics: [
      ...semantic.map((d) => formatDiagnostic(root, d)),
      ...declLines,
    ],
  };
}

/** One unit the walk keyed: a source component holding a checked file. */
export interface KeyedUnit {
  key: string;
  /** Its repo source files (graph nodes). */
  nodes: number[];
  /** Whether it was checked this run (else its results came from the store). */
  checked: boolean;
}

export interface KeyedCheck {
  graph: ProgramGraph;
  /** Each node's shape: a source file's signature, a declaration input's version. */
  shapes: string[];
  /** Every repo source file's contract edges. */
  contracts: Map<number, Contract>;
  /** Every repo source file's result, checked or stored. */
  results: Map<number, FileResult>;
  units: KeyedUnit[];
  /** Every repo file's type fingerprint (what keys its typed lint parts). */
  typeFps: Map<string, string>;
  /** One transcript line: what was reused, what was checked, what it cost. */
  summary: string;
}

/**
 * Run the walk over `program`. `all` checks every unit whatever the store
 * holds (the cold program a dual run compares against); `keyed` checks only
 * the units whose key the store does not hold. Every unit it checks is
 * recorded.
 */
export function keyedCheck(input: {
  root: string;
  program: ts.Program;
  options: ts.CompilerOptions;
  engineFp: string;
  store: FileResultsLookup;
  mode: "keyed" | "all";
}): KeyedCheck {
  const { root, program, options, engineFp, store, mode } = input;
  if (!options.skipLibCheck) {
    throw new Error(
      "type-check: the keyed check leaves declaration inputs unchecked, which is only sound under skipLibCheck",
    );
  }
  const start = performance.now();
  const graph = programGraph(root, program);
  const graphMs = performance.now() - start;
  const { paths, versions, succ } = graph;
  const n = paths.length;
  const files = program.getSourceFiles();
  const resolver = contractResolver(
    root,
    program,
    options,
    paths,
    graph.global,
  );
  const globalFp = globalHash(graph, engineFp);

  const shapes: string[] = new Array<string>(n);
  const contractSucc: (readonly number[] | undefined)[] = new Array<
    readonly number[] | undefined
  >(n);
  const contracts = new Map<number, Contract>();
  const results = new Map<number, FileResult>();
  const compHash: (string | undefined)[] = new Array<string | undefined>(n);
  const units: KeyedUnit[] = [];
  let checkMs = 0;
  let largest = 0;

  const all = paths.map((_, i) => i);
  forEachComponent(
    all,
    (v) => succ[v]!,
    (members) => {
      const own = new Set(members);
      const checked = members.filter((i) => needsContract(paths[i]!));
      for (const i of members) {
        if (needsContract(paths[i]!)) continue;
        shapes[i] = versions[i]!;
        contractSucc[i] = succ[i]!;
      }
      if (checked.length > 0) {
        const lines = members
          .map((i) => {
            const leaving = succ[i]!.filter((d) => !own.has(d));
            return `${paths[i]}\0${versions[i]}\0${typeFpOf(globalFp, leaving, compHash)}`;
          })
          .sort();
        const key = sha256(`unit\n${lines.join("\n")}`);
        const stored = mode === "keyed" ? store.read(key) : undefined;
        const hit =
          stored !== undefined &&
          checked.every((i) => stored[paths[i]!] !== undefined);
        if (hit) {
          for (const i of checked) results.set(i, stored[paths[i]!]!);
        } else {
          const t0 = performance.now();
          const fresh: UnitResults = {};
          for (const i of checked) {
            const r = checkFile(root, program, files[i]!);
            results.set(i, r);
            fresh[paths[i]!] = r;
          }
          checkMs += performance.now() - t0;
          largest = Math.max(largest, checked.length);
          store.record(key, fresh);
        }
        units.push({ key, nodes: checked, checked: !hit });
        for (const i of checked) {
          const r = results.get(i)!;
          shapes[i] = r.signature;
          const refs = resolver.refs(i, r.specs);
          contracts.set(i, { refs });
          contractSucc[i] = refs;
        }
      }
      hashComponents(
        members,
        contractSucc,
        (i) => `${paths[i]}\0${shapes[i]}`,
        compHash,
      );
    },
  );

  const typeFps = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    if (isRepoPath(paths[i]!)) {
      typeFps.set(paths[i]!, typeFpOf(globalFp, succ[i]!, compHash));
    }
  }

  const checkedUnits = units.filter((u) => u.checked);
  const checkedFiles = checkedUnits.reduce((s, u) => s + u.nodes.length, 0);
  const ms = (x: number): number => Math.round(x);
  return {
    graph,
    shapes,
    contracts,
    results,
    units,
    typeFps,
    summary:
      `keyed check (${mode}): ${checkedFiles} of ${results.size} files checked ` +
      `(${checkedUnits.length} of ${units.length} units, largest ${largest}), ` +
      `${results.size - checkedFiles} reused; graph ${ms(graphMs)}ms, ` +
      `check ${ms(checkMs)}ms, walk ${ms(performance.now() - start - graphMs - checkMs)}ms`,
  };
}

/**
 * Compare the walk's results with a full check's, file by file — the dual
 * mode's verdict on the walk. Both must come from programs over the same tree.
 */
export function compareResults(
  keyed: KeyedCheck,
  full: KeyedCheck,
): TscDivergence[] {
  const out: TscDivergence[] = [];
  const fullByPath = new Map<string, FileResult>();
  for (const [i, r] of full.results) fullByPath.set(full.graph.paths[i]!, r);
  for (const [i, k] of keyed.results) {
    const file = keyed.graph.paths[i]!;
    const f = fullByPath.get(file);
    fullByPath.delete(file);
    if (f === undefined) {
      out.push({ file, kind: "missing", keyed: "checked", full: "absent" });
      continue;
    }
    if (k.signature !== f.signature) {
      out.push({
        file,
        kind: "signature",
        keyed: k.signature,
        full: f.signature,
      });
    }
    const kd = [...k.diagnostics].sort().join("\n");
    const fd = [...f.diagnostics].sort().join("\n");
    if (kd !== fd) out.push({ file, kind: "diagnostics", keyed: kd, full: fd });
  }
  for (const file of fullByPath.keys()) {
    out.push({ file, kind: "missing", keyed: "absent", full: "checked" });
  }
  return out;
}
