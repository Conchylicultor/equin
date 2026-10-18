import { sep } from "path";
import {
  walkFiles,
  readIfExists,
  findImports,
  findMarkerCalls,
  markerCallSpans,
  maskSource,
  matchBracket,
  lineAt,
  parseBoolField,
  parseStringField,
  parseStaticCallId,
  unresolvableCallIdMessage,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  resourceDescriptorFactories,
  resourceRegisterMarkers,
  isResourceVocabularyOwner,
  mintsOf,
  type ResourceMembership,
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

/** One source file of the plugin being scanned. */
export interface SourceFile {
  /** Path as walked — quoted in error messages, so it must be openable. */
  path: string;
  src: string;
}

export interface DescriptorInfo {
  key: string;
  keyed: boolean;
  membership: ResourceMembership | null;
  /**
   * The declaration opts into `load: "on-demand"` (a `liveValue`): served as the
   * runtime's `invalidate`. Read at the DECLARATION, the one place the delivery
   * mode is written — `serveValue` takes no `load`.
   */
  onDemand?: true;
}

/** How one local identifier got into a file. */
interface Binding {
  /** The name it was exported under (`import { A as B }` binds B to A). */
  exported: string;
  /** Module specifier it came from, or null for a module-level `const`. */
  specifier: string | null;
}

/** Every identifier of one file a descriptor argument could resolve through. */
export type FileBindings = Map<string, Binding>;

/**
 * Resolve a descriptor imported from ANOTHER plugin's barrel — `null` when the
 * specifier names no plugin this resolver can read.
 *
 * Cross-plugin descriptors are rare but real: `mail/sync` serves
 * `mail-sync-state`, whose descriptor is declared in `mail/mail-core`. The old
 * scanner assumed a descriptor is always declared in the plugin that serves it
 * and silently dropped those; they are exactly the resources this facet exists
 * to report.
 */
export type ImportedDescriptorResolver = (
  specifier: string,
  exportedName: string,
) => DescriptorInfo[] | null;

/**
 * Scan sources for descriptor factory calls and map each declared const name to
 * one `{ key, keyed, membership }` PER RESOURCE THE CALL MINTS — one for a plain
 * descriptor factory, three for `liveCollection("k", …)` (`k`, `k:rows` and
 * `k:groups`), only `k:rows` when it is lookup-only, or `k` and `k:rows` when
 * it is declared `all` (the vocabulary's `mintsOf` keeps the mints whose
 * `requires` field the spec sets). Pass the WHOLE plugin's sources: a descriptor
 * is declared in `core/`/`shared/` but referenced by the register call in
 * `server/`/`central/`.
 *
 * THROWS on a `const x = <factory>(…)` whose key is not a static string literal,
 * unless the plugin owns the factory (see `isResourceVocabularyOwner`: inside
 * `live-state` / `query-resource` / `network/live` a factory call is the
 * wrapper IMPLEMENTING it, called with a computed key, not a plugin declaring a
 * resource). A call not
 * bound to a `const` is skipped rather than raised — it is a wrapper's internal
 * use or a `return` expression, with no name for a register call to reference;
 * if a register call somehow does reference it, that call raises instead.
 */
export function buildDescriptorIndex(
  files: SourceFile[],
  opts: { ownerPlugin: boolean },
): Map<string, DescriptorInfo[]> {
  const index = new Map<string, DescriptorInfo[]>();
  for (const { path, src } of files) {
    let masked: string | null = null;
    for (const [factory, entry] of Object.entries(
      resourceDescriptorFactories,
    )) {
      if (!src.includes(factory)) continue; // cheap fast-path
      // `markerCallSpans` needs a FULL mask, so a factory call written inside a
      // string or comment is never matched; the key is read back from the
      // ORIGINAL at the call's arg span.
      masked ??= maskSource(src);
      for (const span of markerCallSpans(masked, factory)) {
        const name = declaredConstName(masked, span.identifier);
        if (!name) continue;
        const id = parseStaticCallId(src, span);
        if (id.kind !== "value") {
          if (opts.ownerPlugin) continue;
          throw new Error(
            unresolvableCallIdMessage({
              marker: factory,
              file: path,
              line: lineAt(src, span.identifier),
              expr: id.kind === "dynamic" ? id.expr : "",
              hint:
                "A resource's key is read from source text by the docs facet and by " +
                "the eager-tier generator, so it must be a literal at the declaration " +
                "site — a descriptor whose key neither can read would silently vanish " +
                "from docs/plugins-details.md and never pin its plugin eager. Inline " +
                "the literal instead of hoisting or interpolating it.",
            }),
          );
        }
        const argsText = src.slice(span.open + 1, span.close);
        const where = { file: path, line: lineAt(src, span.identifier) };
        const onDemand = declaresOnDemand(argsText, where);
        index.set(
          name,
          mintsOf(entry, argsText, where).map((m) => ({
            key: id.value + m.suffix,
            keyed: m.keyed,
            membership: m.membership,
            ...(onDemand ? { onDemand: true as const } : {}),
          })),
        );
      }
    }
  }
  return index;
}

/**
 * Whether a declaration's spec object (the first `{ … }` of its args — the key
 * is a string literal, masked, so its text can never open one) sets
 * `load: "on-demand"` (or `"snapshot"`), or `bytes: true` (always on demand),
 * at its own depth. THROWS on a non-literal `load:`: it
 * decides what the docs say the resource is.
 */
function declaresOnDemand(
  argsText: string,
  where: { file: string; line: number },
): boolean {
  const masked = maskSource(argsText);
  const body = objectBodyAt(argsText, masked, masked.indexOf("{"));
  if (body === null) return false;
  // A bytes value is always on demand, whatever it says of `load`.
  if (parseBoolField(body, "bytes", { depth0: true })) return true;
  const f = parseStringField(body, "load", { depth0: true });
  if (f.kind === "dynamic") {
    throw new Error(
      `${where.file}:${where.line}: a resource declaration's \`load:\` is not a ` +
        `static string literal — got \`${f.expr}\`. The docs facet reads it from ` +
        "source text; write the literal at the declaration.",
    );
  }
  // `"snapshot"` is on-demand too (re-measured when a reader asks).
  return (
    f.kind === "value" && (f.value === "on-demand" || f.value === "snapshot")
  );
}

/**
 * The identifier bindings of one file: every imported name (with the specifier
 * it came from) and every module-level `const`.
 *
 * `findImports` masks strings/comments/regex fully and reads each specifier back
 * by offset, so an import written inside a string/template literal can never
 * register a phantom binding. The import half mirrors the original alias regex:
 * keep `import` (not `export`), keep type-only, and only parse a clause whose
 * post-`type` head is the named block.
 */
export function parseFileBindings(src: string): FileBindings {
  const bindings: FileBindings = new Map();
  for (const imp of findImports(src)) {
    if (imp.keyword !== "import" || imp.sideEffect) continue;
    const clause = imp.clause.replace(/^\s*type\s+/, "");
    const braceIdx = clause.indexOf("{");
    if (braceIdx < 0 || clause.slice(0, braceIdx).trim() !== "") continue;
    const closeIdx = clause.indexOf("}", braceIdx);
    const names = clause.slice(
      braceIdx + 1,
      closeIdx < 0 ? clause.length : closeIdx,
    );
    for (const raw of names.split(",")) {
      const spec = raw.trim().replace(/^type\s+/, "");
      const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(
        spec,
      );
      if (aliased) {
        bindings.set(aliased[2]!, {
          exported: aliased[1]!,
          specifier: imp.specifier,
        });
      } else if (/^[A-Za-z_$][\w$]*$/.test(spec)) {
        bindings.set(spec, { exported: spec, specifier: imp.specifier });
      }
    }
  }

  // Module scope only: the `const` must start its line with no indentation, so a
  // `const` inside a function body (or a destructured parameter) is not one. An
  // import binding of the same name wins — it carries the specifier.
  //
  // Column 0 rather than brace tracking, and a miss here is harmless in both
  // directions: a descriptor declared in the same file is found through the
  // INDEX regardless of indentation, and an identifier this misses is treated as
  // a runtime value — dropped rather than raised, which is the conservative
  // direction for a rule that decides whether to fail the build.
  const constRe = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/gm;
  const masked = maskSource(src);
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(masked))) {
    const name = m[1]!;
    if (!bindings.has(name))
      bindings.set(name, { exported: name, specifier: null });
  }

  return bindings;
}

/**
 * Resolve one register call's `argsText` to the `ResourceDef`s it serves — one
 * per resource its descriptor minted (a collection serves several).
 *
 * Two shapes carry a key. The DESCRIPTOR form passes a descriptor identifier as
 * the first argument (`defineResource(tasksResource, opts)`). The FLAT form
 * inlines an object literal whose `key:` is either a string literal or a
 * descriptor's `.key` (`defineResource({ key: value.key, mode, … })`) —
 * both name the same descriptor, so both resolve through the same
 * {@link resolveDescriptorIdentifier}.
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
  const head = stripLeadingTrivia(argsText);
  if (head.startsWith("{")) {
    // Flat inline object form: the key and the mode live in the object literal.
    const keyField = parseStringField(argsText, "key");
    if (keyField.kind === "absent") return [];
    if (keyField.kind === "value") {
      return [
        { key: keyField.value, mode: literalMode(marker, argsText, where) },
      ];
    }
    const member = /^([A-Za-z_$][\w$]*)\.key$/.exec(keyField.expr.trim());
    if (!member) {
      throw new Error(
        unresolvableCallIdMessage({
          marker,
          file: where.file,
          line: where.line,
          expr: keyField.expr,
          hint:
            "A register call's `key:` is read from source text by the docs facet, so " +
            "it must be a string literal or `<descriptor>.key` naming a descriptor " +
            "declared with a literal key — anything else would silently vanish from " +
            "docs/plugins-details.md. Pass the descriptor's `.key`, or inline the literal.",
        }),
      );
    }
    const infos = resolveDescriptorIdentifier(
      marker,
      member[1]!,
      bindings,
      index,
      where,
      resolveImported,
    );
    if (infos === null) return [];
    // The flat form's literal `mode:` is what the runtime serves; the
    // descriptor only supplies the key (and bounded membership, if any).
    const mode = literalMode(marker, argsText, where);
    return infos.map((info) =>
      info.membership
        ? { key: info.key, mode, membership: info.membership }
        : { key: info.key, mode },
    );
  }
  // Descriptor form: the first arg is an identifier bound to a descriptor.
  const idMatch = /^([A-Za-z_$][\w$]*)/.exec(head);
  if (!idMatch) return [];
  const infos = resolveDescriptorIdentifier(
    marker,
    idMatch[1]!,
    bindings,
    index,
    where,
    resolveImported,
  );
  if (infos === null) return [];
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

/**
 * Resolve a descriptor identifier used at a register call — through the
 * plugin's own descriptor index, then (for an import) the other plugin's.
 * `null` when it is a runtime value (bound by neither an import nor a
 * module-level const); THROWS when it is bound but names no descriptor.
 */
function resolveDescriptorIdentifier(
  marker: string,
  local: string,
  bindings: FileBindings,
  index: Map<string, DescriptorInfo[]>,
  where: { file: string; line: number },
  resolveImported: ImportedDescriptorResolver,
): DescriptorInfo[] | null {
  const binding = bindings.get(local);
  const info =
    index.get(binding?.exported ?? local) ??
    (binding?.specifier != null
      ? resolveImported(binding.specifier, binding.exported)
      : null);
  if (info) return info;
  if (!binding) return null; // runtime value — a parameter, never resolvable from text
  throw new Error(
    unresolvableCallIdMessage({
      marker,
      file: where.file,
      line: where.line,
      expr: local,
      hint:
        `\`${local}\` is bound in this file but is not a descriptor this scanner ` +
        "can resolve. If it comes from a descriptor factory the vocabulary does " +
        "not know, add that factory to " +
        "plugins/framework/plugins/tooling/plugins/resource-vocabulary/core — " +
        "until it is listed, this resource is invisible to docs/plugins-details.md " +
        "and to the eager-tier generator. Otherwise declare the descriptor as a " +
        "module-level const with a literal key and pass that identifier.",
    }),
  );
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

// ── low-level text helpers ─────────────────────────────────────────────────

/** Name in the `(export) const <name> = ` that immediately precedes a marker call. */
function declaredConstName(src: string, markerIdx: number): string | null {
  const before = src.slice(0, markerIdx);
  const m = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*$/.exec(
    before,
  );
  return m ? m[1]! : null;
}

/** Drop leading whitespace and line/block comments (offsets are irrelevant here). */
function stripLeadingTrivia(s: string): string {
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === "/" && s[i + 1] === "/") {
      i += 2;
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  return s.slice(i);
}
