import {
  lineAt,
  markerCallSpans,
  maskSource,
  matchBracket,
  parseBoolField,
  parseStaticCallId,
  parseStringField,
  findImports,
  hasField,
  unresolvableCallIdMessage,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { mintsOf } from "./mints";
import {
  resourceDescriptorFactories,
  type ResourceMembership,
} from "./vocabulary";

// The one reading of a resource DECLARATION (`liveValue("key", …)`,
// `liveCollection("key", …)`) and of the descriptor a register call names, from
// source text — shared by the `resources` docs facet (what each plugin SERVES)
// and codegen's browser-host coverage guard (what a scoped page READS, and
// whether the host's worker serves it). Both used to need it; one copy.
//
// WHAT IT CANNOT RESOLVE, IT REFUSES. Every miss either resolves or throws,
// naming file, line and the offending expression. The one legitimate
// unresolvable shape is a runtime descriptor value (a function parameter inside
// the query compiler), exempted by NAME BINDING rather than by silence: an
// identifier that is neither imported nor a module-level const in the file is
// not something a text scanner ever could have resolved.

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
  /**
   * The declaration sets `needsMachine` (any value — the feature is a runtime
   * object): only the desktop app's own server answers it, every other host
   * renders it "not available".
   */
  needsMachine?: true;
  /** The declaration sets `origin: "central"`: central serves it, not the worktree backend. */
  origin?: "central";
}

/** How one local identifier got into a file. */
interface Binding {
  /** The name it was exported under (`import { A as B }` binds B to A). */
  exported: string;
  /** Module specifier it came from, or null for a module-level `const`. */
  specifier: string | null;
  /** Imported with `import type` / `type X` — erased, never a runtime value. */
  typeOnly?: true;
}

/** Every identifier of one file a descriptor argument could resolve through. */
export type FileBindings = Map<string, Binding>;

/**
 * Resolve a descriptor imported from ANOTHER plugin's barrel — `null` when the
 * specifier names no plugin this resolver can read.
 *
 * Cross-plugin descriptors are rare but real: `mail/sync` serves
 * `mail-sync-state`, whose descriptor is declared in `mail/mail-core`.
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
 * resource). A call not bound to a `const` is skipped rather than raised — it
 * is a wrapper's internal use or a `return` expression, with no name for a
 * register call to reference; if a register call somehow does reference it,
 * that call raises instead.
 */
export function buildDescriptorIndex(
  files: readonly SourceFile[],
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
                "A resource's key is read from source text by the docs facet, by " +
                "the eager-tier generator and by the browser-host coverage guard, so " +
                "it must be a literal at the declaration site — a descriptor whose key " +
                "they cannot read would silently vanish from all three. Inline the " +
                "literal instead of hoisting or interpolating it.",
            }),
          );
        }
        const argsText = src.slice(span.open + 1, span.close);
        const where = { file: path, line: lineAt(src, span.identifier) };
        const traits = declarationTraits(argsText, where);
        index.set(
          name,
          mintsOf(entry, argsText, where).map((m) => ({
            key: id.value + m.suffix,
            keyed: m.keyed,
            membership: m.membership,
            ...traits,
          })),
        );
      }
    }
  }
  return index;
}

/**
 * What a declaration's spec object (the first `{ … }` of its args — the key is
 * a string literal, masked, so its text can never open one) says at its own
 * depth beyond what it mints: whether it is on demand (`load: "on-demand"` /
 * `"snapshot"`, or `bytes: true`), needs the computer (`needsMachine`) or is
 * central's (`origin: "central"`). THROWS on a non-literal `load:` or
 * `origin:` — each decides what the resource is.
 */
function declarationTraits(
  argsText: string,
  where: { file: string; line: number },
): Pick<DescriptorInfo, "onDemand" | "needsMachine" | "origin"> {
  const masked = maskSource(argsText);
  const body = objectBodyAt(argsText, masked, masked.indexOf("{"));
  if (body === null) return {};
  const literal = (field: string): string | undefined => {
    const f = parseStringField(body, field, { depth0: true });
    if (f.kind === "absent") return undefined;
    if (f.kind === "dynamic") {
      throw new Error(
        `${where.file}:${where.line}: a resource declaration's \`${field}:\` is ` +
          `not a static string literal — got \`${f.expr}\`. The scanners read it ` +
          "from source text; write the literal at the declaration.",
      );
    }
    return f.value;
  };
  // A bytes value is always on demand, whatever it says of `load`; `"snapshot"`
  // is on demand too (re-measured when a reader asks).
  const bytes = parseBoolField(body, "bytes", { depth0: true });
  const load = bytes ? undefined : literal("load");
  const onDemand = bytes || load === "on-demand" || load === "snapshot";
  // `needsMachine`'s value is a runtime object (a feature, often a shared
  // const): only its PRESENCE is read — as a key, or a shorthand member.
  const needsMachine = hasField(body, "needsMachine", { depth0: true });
  const origin = literal("origin");
  if (origin !== undefined && origin !== "central") {
    throw new Error(
      `${where.file}:${where.line}: a resource declaration's \`origin:\` is ` +
        `"${origin}" — the only origin a declaration names is "central".`,
    );
  }
  return {
    ...(onDemand ? { onDemand: true as const } : {}),
    ...(needsMachine ? { needsMachine: true as const } : {}),
    ...(origin === "central" ? { origin: "central" as const } : {}),
  };
}

/**
 * The identifier bindings of one file: every imported name (with the specifier
 * it came from) and every module-level `const`.
 *
 * `findImports` masks strings/comments/regex fully and reads each specifier back
 * by offset, so an import written inside a string/template literal can never
 * register a phantom binding. Keeps `import` (not `export`), keeps type-only
 * (marked `typeOnly`), and only parses a clause whose post-`type` head is the
 * named block.
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
      const itemType = /^\s*type\s+/.test(raw);
      const spec = raw.trim().replace(/^type\s+/, "");
      const typeOnly = imp.typeOnly || itemType;
      const base = {
        specifier: imp.specifier,
        ...(typeOnly ? { typeOnly: true as const } : {}),
      };
      const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(
        spec,
      );
      if (aliased) {
        bindings.set(aliased[2]!, { exported: aliased[1]!, ...base });
      } else if (/^[A-Za-z_$][\w$]*$/.test(spec)) {
        bindings.set(spec, { exported: spec, ...base });
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

/** What a register call's first argument names, before any mode is read. */
export type RegisterCallTarget =
  /** The flat form's literal `key:` — no descriptor behind it. */
  | { kind: "literal"; key: string; flat: true }
  /** A descriptor (every resource it mints); `flat` for `{ key: x.key, … }`. */
  | { kind: "descriptor"; infos: DescriptorInfo[]; flat: boolean };

/**
 * What one register call's `argsText` serves — the key half of reading it, the
 * delivery mode left to the caller (the docs facet reads it; the coverage
 * guard needs only the keys).
 *
 * Two shapes carry a key. The DESCRIPTOR form passes a descriptor identifier as
 * the first argument (`serveCollection(tasksResource, opts)`). The FLAT form
 * inlines an object literal whose `key:` is either a string literal or a
 * descriptor's `.key` (`defineResource({ key: value.key, mode, … })`) — both
 * name the same descriptor, so both resolve through the same
 * {@link resolveDescriptorIdentifier}.
 *
 * `null` only for a shape this scanner could never have resolved: the flat form
 * with no `key:` at all, or a descriptor that is a RUNTIME VALUE — an
 * identifier bound by neither an import nor a module-level const, i.e. a
 * function parameter.
 *
 * THROWS on everything else it cannot read: an identifier that IS bound in the
 * file but resolves to no descriptor (what a descriptor minted by an unknown
 * factory looks like from here), and a flat `key:` that is neither a literal
 * nor `<identifier>.key`.
 */
export function registerCallTarget(
  marker: string,
  argsText: string,
  bindings: FileBindings,
  index: Map<string, DescriptorInfo[]>,
  where: { file: string; line: number },
  resolveImported: ImportedDescriptorResolver,
): RegisterCallTarget | null {
  const head = stripLeadingTrivia(argsText);
  if (head.startsWith("{")) {
    const keyField = parseStringField(argsText, "key");
    if (keyField.kind === "absent") return null;
    if (keyField.kind === "value") {
      return { kind: "literal", key: keyField.value, flat: true };
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
    return infos === null ? null : { kind: "descriptor", infos, flat: true };
  }
  const idMatch = /^([A-Za-z_$][\w$]*)/.exec(head);
  if (!idMatch) return null;
  const infos = resolveDescriptorIdentifier(
    marker,
    idMatch[1]!,
    bindings,
    index,
    where,
    resolveImported,
  );
  return infos === null ? null : { kind: "descriptor", infos, flat: false };
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
