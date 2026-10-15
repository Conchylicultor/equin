import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  listCandidateSources,
  type CandidateSource,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  findImports,
  lineAt,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// ── investigate:failures-registered ────────────────────────────────────────
// A collection (or a union arm) whose rows can be FAILED — one of its fields
// declares an option tinted `variant: "destructive"`, the tint reserved for
// "the one outcome someone must act on" — gets the Investigate action in every
// list of it only once something registers it (`Investigate.Register({ owner
// })`, or a helper built on it such as runs' `investigateRuns(arm, …)`). Without
// the registration it type-checks and renders, and its failed rows simply
// offer nothing: exactly how most failure surfaces ended up without one.
//
// Read off whole files with comments and strings masked (offsets kept, so the
// raw text of a span is the same slice of the unmasked source). A name is
// resolved per file: a local `const` by its own initializer, an imported one
// by the name it was exported under. The failure tint reaches a declaration
// directly (`options: { failed: { variant: "destructive" } }`) or through any
// chain of constants (`options: RUN_OUTCOME_OPTIONS_META`, `fields:
// runFields`), followed across files.

const ID = "investigate:failures-registered";

/** A `liveCollection(` / `liveArm(` call — not a function's own definition. */
const DECLARATION =
  /(?<!\bfunction\s+)\b(?:liveCollection|liveArm)\s*(?:<[^()]*>)?\s*\(/g;
/** The failure tint, in raw source. */
const DESTRUCTIVE = /\bvariant\s*:\s*["']destructive["']/;
/** A `const x =` / `const x: T =` declaration. */
const CONST = /\bconst\s+(\w+)\s*(?::[^=;]*)?=/g;
/** The binding a call initializes: `const x =` right before it. */
const BOUND = /\bconst\s+(\w+)\s*(?::[^=;]*)?=\s*$/;
/** An `Investigate.Register(` call. */
const REGISTER = /\bInvestigate\s*\.\s*Register\s*(?:<[^()]*>)?\s*\(/g;
/** A union collection's `arms:` key. */
const ARMS = /\barms\s*:/;
/** A collection a list can draw: a `default:` window or an `all:` set. */
const LISTED = /\b(?:default|all)\s*:/;
/** An exported function — a candidate registration helper when its file calls `Investigate.Register`. */
const EXPORTED_FN = /\bexport\s+function\s+(\w+)/g;

const notTest = (f: CandidateSource) => !isTestCodePath(f.rel.split("/"));

/** Local binding → the name it was imported under. */
function importAliases(file: CandidateSource): Map<string, string> {
  const imported = new Map<string, string>();
  for (const imp of findImports(file.src)) {
    const braces = /\{([^}]*)\}/.exec(imp.clause)?.[1];
    if (braces === undefined) continue;
    for (const spec of braces.split(",")) {
      const m = /^\s*(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(spec);
      if (m) imported.set(m[2] ?? m[1]!, m[1]!);
    }
  }
  return imported;
}

/** From just after an opening `(` to its matching `)`. */
function callArgs(masked: string, afterOpen: number): string {
  let depth = 1;
  for (let i = afterOpen; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return masked.slice(afterOpen, i);
  }
  return masked.slice(afterOpen);
}

/** A `const` initializer: from after `=` to the `;` (or blank line) closing it at depth 0. */
function initializerEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth <= 0 && ch === ";") return i;
    else if (depth <= 0 && ch === "\n" && masked[i + 1] === "\n") return i;
  }
  return masked.length;
}

interface FileIndex {
  file: CandidateSource;
  masked: string;
  imported: Map<string, string>;
  /** Each local `const`: its initializer's masked and raw text. */
  consts: Map<string, { masked: string; raw: string }>;
}

function indexFile(file: CandidateSource): FileIndex {
  const masked = maskSource(file.src);
  const consts = new Map<string, { masked: string; raw: string }>();
  for (const m of masked.matchAll(CONST)) {
    const start = m.index + m[0].length;
    const end = initializerEnd(masked, start);
    consts.set(m[1]!, {
      masked: masked.slice(start, end),
      raw: file.src.slice(start, end),
    });
  }
  return { file, masked, imported: importAliases(file), consts };
}

/** The identifiers a span names. */
function identifiers(span: string): Set<string> {
  return new Set(span.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []);
}

/**
 * Whether a span of `idx` carries the failure tint: literally, or by naming a
 * local constant that does, or an import of a name `exported` holds.
 */
function spanIsFailure(
  idx: FileIndex,
  raw: string,
  masked: string,
  local: ReadonlySet<string>,
  exported: ReadonlySet<string>,
): boolean {
  if (DESTRUCTIVE.test(raw)) return true;
  for (const id of identifiers(masked)) {
    if (local.has(id)) return true;
    const from = idx.imported.get(id);
    if (from !== undefined && exported.has(from)) return true;
  }
  return false;
}

/** The failure-tinted constants: across files by exported name, and per file. */
interface Tinted {
  /** Names a tinted constant is known by across files. */
  known: Set<string>;
  /** Each file's own tinted locals (a same-named local elsewhere is not one). */
  local: Map<string, Set<string>>;
}

/**
 * Close the failure-tinted constants over `files`: a constant is tinted when
 * its initializer is — literally, or through a constant already known. Local
 * names are per file; across files a tinted constant is known by the name it
 * is exported under.
 */
export function tintedConstants(files: readonly FileIndex[]): Tinted {
  const known = new Set<string>();
  const local = new Map<string, Set<string>>(
    files.map((f) => [f.file.rel, new Set<string>()]),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const idx of files) {
      const mine = local.get(idx.file.rel)!;
      for (const [name, init] of idx.consts) {
        if (mine.has(name)) continue;
        if (spanIsFailure(idx, init.raw, init.masked, mine, known)) {
          mine.add(name);
          known.add(name);
          changed = true;
        }
      }
    }
  }
  return { known, local };
}

/** The failure-bearing declarations no registration names, as `path:line — name`. */
export function unregisteredFailures(
  declaring: readonly CandidateSource[],
  constantSources: readonly CandidateSource[],
  registering: readonly CandidateSource[],
): { path: string; line: number; name: string }[] {
  const byPath = new Map<string, FileIndex>();
  for (const f of [...constantSources, ...declaring].filter(notTest)) {
    if (!byPath.has(f.rel)) byPath.set(f.rel, indexFile(f));
  }
  const files = [...byPath.values()];
  const tinted = tintedConstants(files);

  // Every name an `Investigate.Register(…)` — or a helper exported from a file
  // calling it — passes, undone to the name it was imported under.
  const regFiles = registering.filter(notTest).map(indexFile);
  const helpers = new Set<string>();
  for (const idx of regFiles) {
    if ([...idx.masked.matchAll(REGISTER)].length === 0) continue;
    for (const m of idx.masked.matchAll(EXPORTED_FN)) helpers.add(m[1]!);
  }
  const calls = new RegExp(
    `${REGISTER.source}|\\b(?:${[...helpers].join("|") || "(?!)"})\\s*\\(`,
    "g",
  );
  const registered = new Set<string>();
  for (const idx of regFiles) {
    for (const m of idx.masked.matchAll(calls)) {
      const args = callArgs(idx.masked, m.index + m[0].length);
      for (const id of identifiers(args)) {
        registered.add(idx.imported.get(id) ?? id);
      }
    }
  }

  // Two passes: a UNION's failure tint (its base outcome) is answered by its
  // arms — the rows a list shows are each arm's, so each arm registers — so
  // the union itself is never reported and every `liveArm(<union>, …)` is
  // failure-bearing whatever its own fields say.
  interface Declaration {
    path: string;
    line: number;
    name: string | null;
    kind: "collection" | "arm";
    args: string;
    tinted: boolean;
    idx: FileIndex;
  }
  const declarations: Declaration[] = [];
  for (const f of declaring.filter(notTest)) {
    const idx = byPath.get(f.rel)!;
    const localTinted = tinted.local.get(f.rel) ?? new Set<string>();
    for (const m of idx.masked.matchAll(DECLARATION)) {
      const open = m.index + m[0].length;
      const args = callArgs(idx.masked, open);
      const raw = f.src.slice(open, open + args.length);
      const before = idx.masked.slice(Math.max(0, m.index - 400), m.index);
      declarations.push({
        path: f.rel,
        line: lineAt(f.src, m.index),
        name: BOUND.exec(before)?.[1] ?? null,
        kind: m[0].includes("liveArm") ? "arm" : "collection",
        args,
        tinted: spanIsFailure(idx, raw, args, localTinted, tinted.known),
        idx,
      });
    }
  }
  const tintedUnions = new Set(
    declarations
      .filter((d) => d.kind === "collection" && d.tinted && ARMS.test(d.args))
      .map((d) => d.name)
      .filter((n): n is string => n !== null),
  );

  const missing: { path: string; line: number; name: string }[] = [];
  for (const d of declarations) {
    if (d.kind === "collection") {
      // A union is answered by its arms; a lookup-only collection (no
      // `default` window, no `all` set) is read by id and listed by nothing.
      if (!d.tinted || ARMS.test(d.args) || !LISTED.test(d.args)) continue;
    } else {
      const union = /^\s*(\w+)/.exec(d.args)?.[1];
      const ofTintedUnion =
        union !== undefined &&
        tintedUnions.has(d.idx.imported.get(union) ?? union);
      if (!d.tinted && !ofTintedUnion) continue;
    }
    if (d.name !== null && registered.has(d.name)) continue;
    missing.push({
      path: d.path,
      line: d.line,
      name: d.name ?? "(an unbound declaration)",
    });
  }
  return missing;
}

const failuresRegistered: Check = {
  id: ID,
  // INPUT-KEYED: a pure scan of tracked sources.
  inputKeyed: true,
  exemptable: {
    [ID]: 'declares a collection (or union arm) with a failure-tinted option (`variant: "destructive"`) whose failed rows offer no Investigate action — sanctioned only where that tint does not mean a failure someone must act on',
  },
  outOfScope: ["test"],
  description:
    'Every collection or union arm (`liveCollection` / `liveArm`) declaring a field option tinted `variant: "destructive"` — directly or through constants — is registered for the Investigate action: an `Investigate.Register({ owner })` (primitives/launch/investigate), or a helper built on it such as runs\' `investigateRuns(arm, …)`, names it. Otherwise its failed rows offer no way to launch an agent on them.',
  async run(ctx) {
    const root = await getWorktreeRoot();
    const [declaring, constants, registering] = await Promise.all([
      listCandidateSources({
        root,
        grepArg: "liveCollection|liveArm",
        fixed: false,
      }),
      listCandidateSources({ root, grepArg: "destructive", fixed: true }),
      listCandidateSources({
        root,
        grepArg: "Investigate|investigate",
        fixed: false,
      }),
    ]);
    // Follow tinted constants across files: each pass adds the files naming a
    // constant found so far, until no new file appears.
    const sources = new Map(constants.map((f) => [f.rel, f]));
    for (let pass = 0; pass < 8; pass++) {
      const names = tintedConstants(
        [...sources.values(), ...declaring].filter(notTest).map(indexFile),
      ).known;
      if (names.size === 0) break;
      const more = await listCandidateSources({
        root,
        // git grep's extended regexp: a plain alternation (a wider net is
        // harmless — every file is parsed anyway).
        grepArg: [...names].join("|"),
        fixed: false,
      });
      const before = sources.size;
      for (const f of more) if (!sources.has(f.rel)) sources.set(f.rel, f);
      if (sources.size === before) break;
    }
    const exempt = await ctx.exempt(ID);
    const missing = unregisteredFailures(
      declaring,
      [...sources.values()],
      registering,
    ).filter((m) => !exempt.skips(m.path));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${missing.length} failure-bearing collection(s) offer no Investigate action:\n    ${missing
        .map((m) => `${m.path}:${m.line} — ${m.name}`)
        .join("\n    ")}`,
      hint: "From the collection's (or arm's) web barrel, contribute `Investigate.Register({ owner, failed, noun, categoryId, subject, description, brief })` (primitives/launch/investigate/web) — or for a run arm `investigateRuns(arm, …)` (runs/web). If the destructive tint there does not mean a failure someone must act on, exempt the file in the plugin's `exempt/index.ts` (rule `investigate:failures-registered`, kind `sanctioned`, with the reason).",
    };
  },
};

export default [failuresRegistered];
