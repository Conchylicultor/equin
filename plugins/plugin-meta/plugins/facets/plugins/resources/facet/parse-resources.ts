import { sep } from "path";
import {
  walkFiles,
  readIfExists,
  findMarkerCalls,
  maskSource,
  matchBracket,
  lineAt,
  parseStringField,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  buildDescriptorIndex,
  isResourceVocabularyOwner,
  parseFileBindings,
  registerCallTarget,
  resourceRegisterMarkers,
  type DescriptorInfo,
  type FileBindings,
  type ImportedDescriptorResolver,
  type SourceFile,
} from "@plugins/framework/plugins/tooling/plugins/resource-vocabulary/core";
import type { ResourceChanges, ResourceDef, ResourceFacetData } from "../core";

// A resource's identity (`key`), keyed-ness and bounded membership are declared
// at a DESCRIPTOR FACTORY call — `liveValue("key", …)`, `liveCollection("key",
// …)` (a bounded window, its `:rows` point sibling and `:groups`) — which
// lives in a plugin's `core/` or `shared/`. The resource is SERVED where a REGISTER call references that
// descriptor: `serveValue(value, opts)` / `serveCollection(collection, opts)`,
// or the old `defineResource(descriptor, opts)` (in `server/` or `central/`).
// The legacy flat form `defineResource({ key, mode })` (kept for tests) inlines
// the key at the register site, as a literal or as `<descriptor>.key`. The key is resolved
// across files the way the `routes` facet resolves `[endpoint.route]` computed
// keys: an extract-time
// `name → descriptor` map, built over the serving plugin's own sources and, for
// a descriptor imported from another plugin's barrel, over that plugin's.
//
// WHICH NAMES COUNT IS NOT DECIDED HERE. This scanner used to keep its own list
// of three factory names and three marker names, and the eager-tier generator
// kept a second, different list. Neither knew the five bounded-membership
// factories, so ~10 plugins served a resource the docs said they didn't — and
// nothing noticed, because an unrecognised factory produces no match and
// therefore no facet data, which reads exactly like a plugin that declares
// nothing. Both lists are now one derived vocabulary
// (`tooling/resource-vocabulary/core`), whose key set `tsc` checks against the
// barrels themselves.
//
// AND WHAT IT CANNOT RESOLVE, IT REFUSES. Every miss below either resolves or
// throws, naming file, line and the offending expression — the same contract
// `scanDataViewIds` (codegen) and the `contributions` facet already hold. The
// one legitimate unresolvable shape is a runtime descriptor value (a function
// parameter inside the query compiler), and it is exempted by NAME BINDING
// rather than by silence: an identifier that is neither imported nor a
// module-level const in the file is not something this scanner ever could have
// resolved.

/**
 * Resolve one register call's `argsText` to the `ResourceDef`s it serves — one
 * per resource its descriptor minted (a collection serves several).
 *
 * Two shapes carry a key. The DESCRIPTOR form passes a descriptor identifier as
 * the first argument (`defineResource(tasksResource, opts)`). The FLAT form
 * inlines an object literal whose `key:` is either a string literal or a
 * descriptor's `.key` (`defineResource({ key: value.key, mode, … })`) —
 * both name the same descriptor, so both resolve through the same
 * resolution (the vocabulary's `registerCallTarget`).
 *
 * Empty only for a shape this scanner could never have resolved: the flat form
 * with no `key:` at all, or a descriptor that is a RUNTIME VALUE — an
 * identifier bound by neither an import nor a module-level const, i.e. a
 * function parameter, which is how the query compiler calls
 * `defineResource(descriptor, …)` on a descriptor handed to it.
 *
 * THROWS on everything else it cannot read: an identifier that IS bound in the
 * file but resolves to no descriptor (what a descriptor minted by an unknown
 * factory looks like from here), a flat `key:` that is neither a literal nor
 * `<identifier>.key` (an interpolated template, a call, a bare constant), and a
 * resolved non-keyed resource whose old form shows no literal `mode:` (see
 * {@link literalMode}). The first two used to disappear silently — the flat
 * branch dropped 14 real resources from docs/plugins-details.md before it
 * resolved `X.key`.
 */
export function resolveRegisterCall(
  marker: string,
  argsText: string,
  bindings: FileBindings,
  index: Map<string, DescriptorInfo[]>,
  where: { file: string; line: number },
  resolveImported: ImportedDescriptorResolver,
): ResourceDef[] {
  // Which descriptor (or flat literal key) the call names — the vocabulary's
  // one reading, shared with the browser-host coverage guard.
  const target = registerCallTarget(
    marker,
    argsText,
    bindings,
    index,
    where,
    resolveImported,
  );
  if (target === null) return [];
  if (target.kind === "literal") {
    return [{ key: target.key, mode: literalMode(marker, argsText, where) }];
  }
  const { infos } = target;
  if (target.flat) {
    // The flat form's literal `mode:` is what the runtime serves; the
    // descriptor only supplies the key (and bounded membership, if any).
    const mode = literalMode(marker, argsText, where);
    return infos.map((info) =>
      info.membership
        ? { key: info.key, mode, membership: info.membership }
        : { key: info.key, mode },
    );
  }
  if (marker === "serveValue") {
    return infos.map((info) => servedValueDef(info, argsText, where));
  }
  // A keyed descriptor fixes the mode — the runtime serves it `keyed` whatever
  // the options say, and the keyed options take no `mode:`. `serveCollection`
  // (and `serveUnionCollection`) serves its one non-keyed mint (`:groups`) as a push value, by
  // construction. Every other non-keyed resource is an old form serving a
  // plain descriptor, whose options must spell the mode.
  return infos.map((info) => {
    const mode = info.keyed
      ? "keyed"
      : marker === "serveCollection" || marker === "serveUnionCollection"
        ? "push"
        : literalMode(marker, argsText, where);
    return info.membership
      ? { key: info.key, mode, membership: info.membership }
      : { key: info.key, mode };
  });
}

/**
 * The literal `mode:` an old register form (`defineResource` /
 * `defineExternalResource`) serves a non-keyed resource with, read at its
 * options object's own depth — the flat form's one object, or the two-arg
 * form's second argument (the first argument is an identifier, so the first
 * `{` opens it) — so a loader's own object literal is never mistaken for it.
 *
 * The runtime has no default: a non-keyed old form without `mode` does not
 * compile. So a missing one here means the text does not SHOW it (an options
 * variable, a spread) — and this THROWS rather than guess, as it does on a
 * non-literal one: the mode decides what the docs say the resource is.
 */
function literalMode(
  marker: string,
  argsText: string,
  where: { file: string; line: number },
): string {
  const masked = maskSource(argsText);
  const body = objectBodyAt(argsText, masked, masked.indexOf("{"));
  const field =
    body === null
      ? ({ kind: "absent" } as const)
      : parseStringField(body, "mode", { depth0: true });
  if (field.kind === "value") return field.value;
  throw new Error(
    `${where.file}:${where.line}: ${marker}(…) serves a non-keyed resource ` +
      (field.kind === "dynamic"
        ? `whose \`mode:\` is not a static string literal — got \`${field.expr}\`. `
        : "with no literal `mode:` in its options object. ") +
      "The docs facet reads the delivery mode from source text, and the runtime " +
      'has no default — write `mode: "push"` or `mode: "invalidate"` as a literal ' +
      "in the options object at the call site.",
  );
}

/**
 * A `serveValue(value, { source, loader, unbounded? })` call: a value is pushed
 * (`push`) unless its DECLARATION opts into `load: "on-demand"` (the runtime's
 * `invalidate` — see {@link DescriptorInfo.onDemand}); a paged value's pages
 * are a keyed window (the vocabulary's `liveValue` mints), served `keyed`
 * whatever the options say, and its `:meta` sibling a push value. `source` and the
 * `unbounded.reason` are recorded as written. Every field is read at the
 * options object's own depth, so an inline loader's object literal (which may
 * well have a `source` or a `reason` of its own) is never mistaken for one.
 * THROWS on a non-literal `source:` / `reason:` — each decides what the docs
 * say the resource is.
 */
function servedValueDef(
  info: DescriptorInfo,
  argsText: string,
  where: { file: string; line: number },
): ResourceDef {
  const def: ResourceDef = info.keyed
    ? {
        key: info.key,
        mode: "keyed",
        ...(info.membership ? { membership: info.membership } : {}),
      }
    : { key: info.key, mode: info.onDemand ? "invalidate" : "push" };
  const masked = maskSource(argsText);
  // The first argument is an identifier, so the first `{` opens the options.
  const optsBody = objectBodyAt(argsText, masked, masked.indexOf("{"));
  if (optsBody === null) return def;
  const literal = (text: string, field: string): string | undefined => {
    const f = parseStringField(text, field, { depth0: true });
    if (f.kind === "absent") return undefined;
    if (f.kind === "dynamic") {
      throw new Error(
        `${where.file}:${where.line}: serveValue(…) \`${field}:\` is not a static ` +
          `string literal — got \`${f.expr}\`. The docs facet reads it from source ` +
          "text; write the literal at the call site.",
      );
    }
    return f.value;
  };
  const source = literal(optsBody, "source");
  if (source === "db" || source === "external") def.source = source;
  const bodyMasked = maskSource(optsBody);
  const changes = declaredChanges(optsBody, bodyMasked, where);
  if (changes !== undefined) def.changes = changes;
  const unbounded = /\bunbounded\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = unbounded.exec(bodyMasked))) {
    // Only the options object's own `unbounded:` (depth 0 of its body).
    if (depthAt(bodyMasked, m.index) !== 0) continue;
    const inner = objectBodyAt(optsBody, bodyMasked, m.index + m[0].length - 1);
    const reason = inner === null ? undefined : literal(inner, "reason");
    if (reason !== undefined) def.unbounded = reason;
    break;
  }
  return def;
}

const CHANGES_ARMS = ["immutable", "fixed", "snapshot"] as const;

/**
 * The options object's own `changes:` (depth 0 of its body): the literal
 * `"notified"`, or the one key of an inline `{ immutable | fixed | snapshot:
 * … }`. Undefined when absent (a db value). THROWS on anything else — an
 * identifier, a spread, another key — because it decides what the docs say
 * about the value's freshness.
 */
function declaredChanges(
  optsBody: string,
  bodyMasked: string,
  where: { file: string; line: number },
): ResourceChanges | undefined {
  const re = /\bchanges\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyMasked))) {
    if (depthAt(bodyMasked, m.index) !== 0) continue;
    const at = m.index + m[0].length;
    if (bodyMasked[at] === "{") {
      const inner = objectBodyAt(optsBody, bodyMasked, at);
      const arm =
        inner === null
          ? null
          : /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(maskSource(inner));
      const name = arm?.[1];
      const known = CHANGES_ARMS.find((a) => a === name);
      if (known !== undefined) return known;
    } else {
      const f = parseStringField(optsBody, "changes", { depth0: true });
      if (f.kind === "value" && f.value === "notified") return "notified";
    }
    throw new Error(
      `${where.file}:${where.line}: serveValue(…) \`changes:\` is not one the docs ` +
        'facet can read — write the literal `"notified"` or an inline ' +
        "`{ immutable | fixed | snapshot: { reason } }` at the call site.",
    );
  }
  return undefined;
}

/** The text strictly inside the `{ … }` opening at `open` (from the ORIGINAL), or null. */
function objectBodyAt(
  src: string,
  masked: string,
  open: number,
): string | null {
  if (open < 0 || masked[open] !== "{") return null;
  const close = matchBracket(masked, open, "{", "}");
  return close < 0 ? null : src.slice(open + 1, close);
}

/** Bracket depth of `masked` at offset `at` (strings/comments already masked). */
function depthAt(masked: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const c = masked[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
  }
  return depth;
}

/** Parse every register call in `files` (one runtime), resolving keys via `index`. */
export function parseRegisterCalls(
  files: SourceFile[],
  index: Map<string, DescriptorInfo[]>,
  resolveImported: ImportedDescriptorResolver,
): ResourceDef[] {
  const out: ResourceDef[] = [];
  const seen = new Set<string>();
  for (const { path, src } of files) {
    const bindings = parseFileBindings(src);
    for (const marker of Object.keys(resourceRegisterMarkers)) {
      if (!src.includes(marker)) continue; // cheap fast-path
      for (const call of findMarkerCalls(src, marker)) {
        const defs = resolveRegisterCall(
          marker,
          call.argsText,
          bindings,
          index,
          { file: path, line: lineAt(src, call.index) },
          resolveImported,
        );
        for (const def of defs) {
          if (seen.has(def.key)) continue;
          seen.add(def.key);
          out.push(def);
        }
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Read every file under `dir` as a `SourceFile`. */
function readPluginSources(dir: string): SourceFile[] {
  const paths: string[] = [];
  walkFiles(dir, paths);
  const files: SourceFile[] = [];
  for (const path of paths) {
    const src = readIfExists(path);
    if (src) files.push({ path, src });
  }
  return files;
}

/**
 * Repo root of an absolute plugin dir — everything before its FIRST `plugins/`
 * segment, which is where a plugin's repo-relative path always starts. `null`
 * when `dir` has none (a test fixture under a temp dir), which disables
 * cross-plugin descriptor resolution rather than guessing at a root.
 */
function repoRootOf(dir: string): string | null {
  const marker = sep + "plugins" + sep;
  const idx = dir.indexOf(marker);
  return idx < 0 ? null : dir.slice(0, idx);
}

/** Extract the server + central resources served by the plugin rooted at `pluginDir`.
 *  A resource served from `machine/` counts as a server resource: the desktop
 *  backend boots `server/` and `machine/` as one plugin graph, on one runtime. */
export function parseResources(pluginDir: string): ResourceFacetData {
  const backendPrefixes = ["server", "machine"].map(
    (folder) => pluginDir + sep + folder + sep,
  );
  const centralPrefix = pluginDir + sep + "central" + sep;

  const all = readPluginSources(pluginDir);
  const serverSources = all.filter((f) =>
    backendPrefixes.some((prefix) => f.path.startsWith(prefix)),
  );
  const centralSources = all.filter((f) => f.path.startsWith(centralPrefix));

  const index = buildDescriptorIndex(all, {
    ownerPlugin: isResourceVocabularyOwner(pluginDir),
  });

  // Cross-plugin descriptors are rare (a handful repo-wide), so the other
  // plugin's index is built ON DEMAND rather than cached: a module-level cache
  // would outlive the build-scoped FS snapshot each extraction pass runs under
  // and could answer a later pass from an older tree.
  const repoRoot = repoRootOf(pluginDir);
  const resolveImported: ImportedDescriptorResolver = (
    specifier,
    exportedName,
  ) => {
    if (repoRoot == null || !specifier.startsWith("@plugins/")) return null;
    // "@plugins/apps/plugins/mail/plugins/mail-core/core" → that plugin's dir.
    const withoutRuntime = specifier
      .replace(/^@plugins\//, "")
      .replace(/\/[^/]+$/, "");
    if (withoutRuntime === "") return null;
    const dir =
      repoRoot + sep + "plugins" + sep + withoutRuntime.split("/").join(sep);
    const files = readPluginSources(dir);
    if (files.length === 0) return null;
    return (
      buildDescriptorIndex(files, {
        ownerPlugin: isResourceVocabularyOwner(dir),
      }).get(exportedName) ?? null
    );
  };

  return {
    server: parseRegisterCalls(serverSources, index, resolveImported),
    central: parseRegisterCalls(centralSources, index, resolveImported),
  };
}
