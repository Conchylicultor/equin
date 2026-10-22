// The ORACLE of the two-program type check: one fresh whole program over every
// root, with TypeScript's own host over the same input — the check's view of
// the repo (`./repo-view.ts`: the run's git tree plus its overlay), so the two
// sides read one tree — every file checked in tsc's own order: no store, no
// served `.d.ts`, no walk. `dual` mode (the daily backstop on main,
// `scripts/dual-check.ts`) runs it beside the check and compares file by file.

import { join } from "path";
import ts from "typescript";
// Through the barrel: the worker imports it the same way.
import type { TscDivergence } from "../core";
import { checkFile } from "./name-check";
import type { NameResult } from "./name-run";
import { isRepoPath, needsContract } from "./keys";
import { viewCompilerHost, type RepoView } from "./repo-view";
import { formatDiagnostic } from "./tsc-engine";

export interface FullCheck {
  results: Map<string, NameResult>;
  programDiagnostics: string[];
}

export function fullCheck(
  view: RepoView,
  options: ts.CompilerOptions,
  roots: readonly string[],
): FullCheck {
  const root = view.root;
  const program = ts.createProgram({
    rootNames: roots.map((p) => join(root, p)),
    options,
    host: viewCompilerHost(view, options),
  });
  // Every file's diagnostics first, in program order — exactly what `tsc`
  // does cold — so the per-file reads below read tsc's own answers back.
  program.getSemanticDiagnostics();
  const results = new Map<string, NameResult>();
  for (const p of roots) {
    if (!isRepoPath(p) || !needsContract(p)) continue;
    const sf = program.getSourceFile(join(root, p));
    if (sf === undefined) {
      throw new Error(
        `type-check: ${p} is a root the whole program does not hold`,
      );
    }
    const { diagnostics, signature } = checkFile(root, program, sf);
    results.set(p, { diagnostics, signature });
  }
  return {
    results,
    programDiagnostics: [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ].map((d) => formatDiagnostic(root, d)),
  };
}

/** The check's results against the oracle's, file by file. */
export function compareResults(
  check: ReadonlyMap<string, NameResult>,
  full: ReadonlyMap<string, NameResult>,
): TscDivergence[] {
  const out: TscDivergence[] = [];
  for (const [file, f] of full) {
    const k = check.get(file);
    if (k === undefined) {
      out.push({ file, kind: "missing", keyed: "absent", full: "checked" });
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
  for (const file of check.keys()) {
    if (!full.has(file)) {
      out.push({ file, kind: "missing", keyed: "checked", full: "absent" });
    }
  }
  return out;
}
