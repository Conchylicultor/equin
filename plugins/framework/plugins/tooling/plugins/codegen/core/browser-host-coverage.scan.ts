// What the browser-host coverage guard (`browser-host-coverage.ts`) reads of
// ONE file, as a file record: a function of the file's bytes and path alone,
// so a build reads it for the files whose blob it has not scanned yet and
// looks every other file up (build pipeline step 13: every scoped source and
// every backend file was read and masked on every build). Import specifiers
// stay unresolved — what they name depends on the file set, which the guard
// resolves against; nothing here does.

import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  endpointExports,
  findImports,
  findMarkerCalls,
  markerCallSpans,
  maskSource,
  matchBracket,
  type EndpointExport,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  buildDescriptorIndex,
  isResourceVocabularyOwner,
  parseFileBindings,
  resourceDescriptorFactories,
  resourceRegisterMarkers,
  type DescriptorInfo,
} from "@plugins/network/plugins/live/plugins/resource-vocabulary/core";

/** One named item of an import/export clause (`{ a, b as c, type D }`). */
export interface NamedItem {
  imported: string;
  local: string;
  typeOnly: boolean;
}

/** One `import … from` / `export … from` of the file, its specifier unresolved. */
export interface RawImport {
  specifier: string;
  /** An `export … from` (a re-export), not an import. */
  reexport: boolean;
  typeOnly: boolean;
  /** `export * from …`. */
  star: boolean;
  items: NamedItem[];
  line: number;
}

/** One entry of a barrel's `httpRoutes` object, in order. */
export type RouteEntry =
  | { kind: "literal"; route: string }
  /** `[local.route]`: resolved to the endpoint `local` names. */
  | { kind: "computed"; local: string; keyText: string }
  /** A key the scan cannot read: thrown, at its position, when the routes are asked. */
  | { kind: "error"; message: string };

export type RoutesFacts =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "entries"; entries: RouteEntry[] };

/** A call of a register marker or of a name that may be a serving wrapper. */
export interface CallSite {
  name: string;
  argsText: string;
  line: number;
}

export interface CoverageFacts {
  imports: RawImport[];
  /** Names declared in the file (`const` / `function` / `class` …). */
  locals: string[];
  /** `export { a as b }` with no `from`: `b` exports `a` (a local or an import). */
  exportAliases: { local: string; imported: string }[];
  /** Imports `pageTransport` or the page pipeline's client accessors. */
  pageBound: boolean;
  /** A page-bound file's first scope fetcher, by line. */
  scopeFetcherLine: number | null;
  descriptors: [string, DescriptorInfo[]][];
  endpoints: EndpointExport[];
  /** For each name the file declares a descriptor or an endpoint under: the line of its second use, when it has one. */
  secondUseLines: Record<string, number>;
  /** Every `"/api/<prefix>` string literal start, by line. */
  rawApi: { prefix: string; line: number }[];
  /** The register markers the file's text names. */
  markers: string[];
  /** Every call of a register marker the file names. */
  calls: CallSite[];
  /** Its module-level functions: name, and the names it hands its first parameter to as their first argument. */
  functions: { name: string; servedBy: string[] }[];
  /** `parseFileBindings`, when the file makes a register call. */
  bindings: [
    string,
    { exported: string; specifier: string | null; typeOnly?: true },
  ][];
  routes: RoutesFacts;
}

/**
 * The imports that bind a module to the page's own server — `pageTransport`
 * and the page pipeline's live-state client accessors, the names
 * `networking/no-page-transport` sanctions one importer at a time.
 */
const PAGE_BOUND_IMPORTS: ReadonlySet<string> = new Set([
  "pageTransport",
  "getNotificationsClient",
  "ensureNotificationsClient",
]);

/** A scope fetcher (the subtree's transport) named in a module. */
const SCOPE_FETCHER_RE =
  /\b(?:useFetchEndpoint|FetchEndpoint|useEndpointMutation)\b/;

const DECL_RE =
  /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
const LOCAL_EXPORT_LIST_RE = /\bexport\s+(type\s+)?\{([^}]*)\}/g;
// An identifier called: `name(` or `name<…>(`.
const CALLED_RE = /([A-Za-z_$][\w$]*)\s*[(<]/g;

const DESCRIPTOR_FACTORIES = Object.keys(resourceDescriptorFactories);
export const REGISTER_MARKERS = Object.keys(resourceRegisterMarkers);

/** A repo path's plugin (`a/plugins/b`) and the folder it sits in, or null outside a plugin folder. */
export function locate(
  path: string,
): { plugin: string; folder: string } | null {
  if (!path.startsWith("plugins/")) return null;
  const segs = path.slice("plugins/".length).split("/");
  const plugin = [segs[0]!];
  let i = 1;
  while (segs[i] === "plugins" && i + 1 < segs.length - 1) {
    plugin.push(segs[i + 1]!);
    i += 2;
  }
  if (i >= segs.length - 1) return null;
  return { plugin: plugin.join("/plugins/"), folder: segs[i]! };
}

/**
 * The named items of an import/export clause (`{ a, b as c, type D }`), as
 * `imported` (the name in the source module) and `local` (the name here — for
 * an export list, the exported name). A default or namespace binding is not a
 * named item and is skipped.
 */
function namedItems(clause: string): NamedItem[] {
  const open = clause.indexOf("{");
  const close = clause.lastIndexOf("}");
  if (open < 0 || close < open) return [];
  const out: NamedItem[] = [];
  for (const raw of clause.slice(open + 1, close).split(",")) {
    const item = raw.trim();
    if (item === "") continue;
    const typeOnly = /^type\s+/.test(item);
    const m =
      /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
        item,
      );
    if (m === null) continue;
    out.push({ imported: m[1]!, local: m[2] ?? m[1]!, typeOnly });
  }
  return out;
}

/** Module-level functions of a masked source: name, first parameter, body span. */
function functionsOf(
  masked: string,
): { name: string; param: string; bodyStart: number; bodyEnd: number }[] {
  const out: {
    name: string;
    param: string;
    bodyStart: number;
    bodyEnd: number;
  }[] = [];
  const re =
    /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>(]*>)?\s*\()/gm;
  for (const m of masked.matchAll(re)) {
    const name = (m[1] ?? m[2])!;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open, "(", ")");
    if (close < 0) continue;
    const param = /^\s*([A-Za-z_$][\w$]*)/.exec(masked.slice(open + 1, close));
    if (param === null) continue;
    // The body: the next `{ … }` after the parameters (a function's, or an
    // arrow's block); an expression-bodied arrow runs to the statement's end.
    const rest = masked.slice(close + 1);
    const brace = /^\s*(?::[^{=]*)?(?:=>)?\s*\{/.exec(rest);
    let bodyStart: number;
    let bodyEnd: number;
    if (brace !== null) {
      bodyStart = close + 1 + brace[0].length - 1;
      bodyEnd = matchBracket(masked, bodyStart, "{", "}");
      if (bodyEnd < 0) continue;
    } else {
      bodyStart = close + 1;
      const end = masked.indexOf(";\n", bodyStart);
      bodyEnd = end < 0 ? masked.length : end;
    }
    out.push({ name, param: param[1]!, bodyStart, bodyEnd: bodyEnd + 1 });
  }
  return out;
}

/**
 * The offsets of `[from, to)` of a masked source that sit outside every
 * bracket — `()`, `[]`, `{}` and a type-argument list `<…>` — calling `visit`
 * on each until it returns true (that offset is returned), else null. A `<`
 * opens a type-argument list only right after an identifier
 * (`handler<A, B>(…)` — a comparison is spaced, `a < b`), and a `>` closes one
 * only while one is open and it is not an arrow's (`=>`).
 */
function scanTopLevel(
  masked: string,
  from: number,
  to: number,
  visit: (i: number, c: string) => boolean,
): number | null {
  let depth = 0;
  let angles = 0;
  for (let i = from; i < to; i++) {
    const c = masked[i]!;
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "<" && i > from && /[\w$]/.test(masked[i - 1]!)) angles++;
    else if (c === ">" && angles > 0 && masked[i - 1] !== "=") angles--;
    else if (depth === 0 && angles === 0 && visit(i, c)) return i;
  }
  return null;
}

/** The comma-separated entries of the object body `[from, to)` of a masked source, top level only. */
function topLevelEntries(
  masked: string,
  from: number,
  to: number,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = from;
  const push = (end: number): void => {
    if (masked.slice(start, end).trim() !== "") out.push({ start, end });
  };
  scanTopLevel(masked, from, to, (i, c) => {
    if (c === ",") {
      push(i);
      start = i + 1;
    }
    return false;
  });
  push(to);
  return out;
}

/** The first `:` of `[from, to)` outside every bracket (see `scanTopLevel`), or null. */
function topLevelColon(
  masked: string,
  from: number,
  to: number,
): number | null {
  return scanTopLevel(masked, from, to, (_i, c) => c === ":");
}

/** Why an `httpRoutes` key cannot be read, as the guard throws it. */
export function unreadableRoute(
  barrel: string,
  key: string,
  why: string,
): string {
  return `${barrel}: \`httpRoutes\` key \`${key}\` ${why} — the browser-host coverage guard reads every route from source, so key it by \`[decl.route]\` (a \`defineEndpoint\` with a literal \`route:\`, in the plugin's \`core/\`) or by a \`"METHOD /path"\` literal`;
}

/**
 * A backend barrel's `httpRoutes` keys, read STRICTLY: a literal
 * `"METHOD /path"` key, or a computed `[endpoint.route]` (resolved by the
 * guard). Any other key — a constant, a template with a substitution, a
 * spread, a shorthand — is recorded as the error the guard throws, so a route
 * the scan cannot read is never dropped. So is an `httpRoutes` that is not one
 * object literal.
 */
function routesOf(rel: string, src: string, masked: string): RoutesFacts {
  if (!src.includes("httpRoutes")) return { kind: "none" };
  const mentions = [...masked.matchAll(/\bhttpRoutes\b/g)];
  if (mentions.length === 0) return { kind: "none" };
  const at = masked.search(/\bhttpRoutes\s*:\s*\{/);
  if (at < 0 || mentions.length > 1) {
    return {
      kind: "error",
      message: `${rel}: \`httpRoutes\` is not one object literal (\`httpRoutes: { … }\`) — the browser-host coverage guard reads its keys from source, so spell them in the barrel`,
    };
  }
  const open = masked.indexOf("{", at);
  const close = matchBracket(masked, open, "{", "}");
  if (close < 0) {
    return {
      kind: "error",
      message: `${rel}: \`httpRoutes\`'s object never closes`,
    };
  }
  const entries: RouteEntry[] = [];
  const unreadable = (key: string, why: string): RouteEntry => ({
    kind: "error",
    message: unreadableRoute(rel, key, why),
  });
  for (const entry of topLevelEntries(masked, open + 1, close)) {
    // The key: the entry up to its first top-level `:` (none: a shorthand,
    // a spread or a method).
    const colon = topLevelColon(masked, entry.start, entry.end);
    const keyMasked = masked.slice(entry.start, colon ?? entry.end).trim();
    const keyText = src.slice(entry.start, colon ?? entry.end).trim();
    if (colon === null) {
      entries.push(unreadable(keyText, "is not a `key: handler` pair"));
      continue;
    }
    const computed = /^\[\s*([A-Za-z_$][\w$]*)\s*\.\s*route\s*\]$/.exec(
      keyMasked,
    );
    if (computed !== null) {
      entries.push({ kind: "computed", local: computed[1]!, keyText });
      continue;
    }
    // A literal key: the masked text blanks string interiors (offsets kept),
    // so its quotes are found there and its text read back from the original.
    const literal = /^(["'`])\s*\1$/.test(keyMasked)
      ? keyText.slice(1, -1)
      : null;
    if (literal === null) {
      entries.push(unreadable(keyText, "is not readable"));
      continue;
    }
    if (keyText.startsWith("`") && literal.includes("${")) {
      entries.push(unreadable(keyText, "is a template with a substitution"));
      continue;
    }
    if (!/^[A-Z]+\s+\//.test(literal)) {
      entries.push(unreadable(keyText, 'is not a `"METHOD /path"` route'));
      continue;
    }
    entries.push({ kind: "literal", route: literal });
  }
  return { kind: "entries", entries };
}

/**
 * `lineAt` over one file, by binary search over its line starts: the scan
 * asks a line for every import and call, and counting newlines from the top
 * each time was most of a cold scan (5.1 of 8.7 s over the repo).
 */
function lineIndex(src: string): (idx: number) => number {
  const starts = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1))
    starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function scan(src: string, rel: string): CoverageFacts {
  const masked = maskSource(src);
  const lineAt = lineIndex(src);
  const imports: RawImport[] = [];
  const bound = new Set<string>();
  let pageBound = false;
  for (const ref of findImports(src, masked)) {
    if (ref.sideEffect) continue;
    const clause = ref.clause.trim();
    const items = namedItems(clause);
    if (ref.keyword !== "export") {
      for (const item of items) {
        if (ref.typeOnly || item.typeOnly) continue;
        if (PAGE_BOUND_IMPORTS.has(item.imported)) pageBound = true;
        bound.add(item.local);
      }
    }
    imports.push({
      specifier: ref.specifier,
      reexport: ref.keyword === "export",
      typeOnly: ref.typeOnly,
      star: /^\*\s*$/.test(clause),
      items,
      line: lineAt(ref.index),
    });
  }
  const locals = new Set<string>();
  for (const x of masked.matchAll(DECL_RE)) locals.add(x[1]!);
  const exportAliases: { local: string; imported: string }[] = [];
  for (const x of masked.matchAll(LOCAL_EXPORT_LIST_RE)) {
    if (x[1] !== undefined) continue;
    const after = masked.slice(x.index + x[0].length).trimStart();
    if (after.startsWith("from")) continue;
    for (const item of namedItems(`{${x[2]!}}`)) {
      if (item.typeOnly || item.local === item.imported) continue;
      exportAliases.push({ local: item.local, imported: item.imported });
    }
  }

  let scopeFetcherLine: number | null = null;
  if (pageBound) {
    const hit = SCOPE_FETCHER_RE.exec(masked);
    if (hit !== null) scopeFetcherLine = lineAt(hit.index);
  }

  const plugin = locate(rel)?.plugin ?? "";
  // `buildDescriptorIndex`'s own fast path, before anything else is asked.
  const descriptors = DESCRIPTOR_FACTORIES.some((f) => src.includes(f))
    ? buildDescriptorIndex([{ path: rel, src, masked }], {
        ownerPlugin: isResourceVocabularyOwner(`plugins/${plugin}`),
      })
    : new Map<string, DescriptorInfo[]>();
  const endpoints = src.includes("defineEndpoint")
    ? endpointExports(rel, src, masked)
    : [];
  const secondUseLines: Record<string, number> = {};
  const declared = new Set([
    ...[...descriptors].filter(([, infos]) => infos.length > 0).map(([n]) => n),
    ...endpoints.map((e) => e.name),
  ]);
  for (const name of declared) {
    const uses = [...masked.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
    if (uses.length >= 2) secondUseLines[name] = lineAt(uses[1]!.index);
  }

  const rawApi: { prefix: string; line: number }[] = [];
  if (src.includes("/api/")) {
    // Sanctioned token-in-string scan (as the routes facet's caller join):
    // the URL lives inside a string, so strings are kept; comments are not.
    const urlMasked = maskSource(src, { strings: false });
    for (const hit of urlMasked.matchAll(/["'`]\/api\/([A-Za-z0-9_-]+)/g))
      rawApi.push({ prefix: hit[1]!, line: lineAt(hit.index) });
  }

  // The register calls, by marker. A call of a serving WRAPPER is not read
  // here — which names are wrappers is the repo's answer, not this file's —
  // but asked of the source by the guard, for the few files that call one
  // (`Module.callsOf`).
  const markers = REGISTER_MARKERS.filter((k) => src.includes(k));
  const calls: CallSite[] = [];
  for (const name of markers) {
    for (const call of findMarkerCalls(src, name, masked))
      calls.push({
        name,
        argsText: call.argsText,
        line: lineAt(call.index),
      });
  }
  // Each module-level function, with the names it hands its first parameter
  // to first: only an imported or declared name (or a marker) can be a
  // register call or a wrapper, and only one the body calls is asked.
  const bindable = new Set([
    ...markers,
    ...bound,
    ...locals,
    ...exportAliases.map((a) => a.local),
  ]);
  const functions: { name: string; servedBy: string[] }[] = [];
  for (const fn of functionsOf(masked)) {
    const body = masked.slice(fn.bodyStart, fn.bodyEnd);
    const called = new Set<string>();
    for (const x of body.matchAll(CALLED_RE))
      if (bindable.has(x[1]!)) called.add(x[1]!);
    if (called.size === 0) continue;
    const first = new RegExp(`^\\s*${fn.param}\\s*[,)]`);
    const servedBy = [...called].filter((name) =>
      markerCallSpans(body, name).some(
        (span) =>
          first.exec(body.slice(span.open + 1, span.close + 1)) !== null,
      ),
    );
    if (servedBy.length > 0) functions.push({ name: fn.name, servedBy });
  }

  return {
    imports,
    locals: [...locals],
    exportAliases,
    pageBound,
    scopeFetcherLine,
    descriptors: [...descriptors],
    endpoints,
    secondUseLines,
    rawApi,
    markers,
    calls,
    functions,
    bindings: calls.length > 0 ? [...parseFileBindings(src, masked)] : [],
    routes: routesOf(rel, src, masked),
  };
}

/** The coverage guard's reading of one file, as a file record. */
export const coverageFactsScan: FileScan<CoverageFacts> = {
  url: import.meta.url,
  scan,
};
