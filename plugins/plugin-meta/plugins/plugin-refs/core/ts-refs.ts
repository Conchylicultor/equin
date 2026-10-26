import {
  asPluginId,
  PLUGIN_FOLDERS,
} from "@plugins/framework/plugins/plugin-id/core";
import { parseRuntimeException } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import { parseEntryPattern } from "@plugins/plugin-meta/plugins/closure/core";
import {
  findImports,
  markerCallSpans,
  maskSource,
  matchBracket,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  assertRange,
  lineIndex,
  PLUGINS_DIR,
  pluginDirPrefix,
  pluginPathFromLiteral,
} from "./resolve";
import type { DotRef, PathRef } from "./types";

const QUOTES = new Set(['"', "'", "`"]);
const SPECIFIER_PREFIX = "@plugins/";

interface Literal {
  /** Offset of the first character inside the quotes. */
  start: number;
  value: string;
}

/**
 * Every string/template literal of a FULLY masked source, read back from the
 * original by offset. `maskSource` keeps delimiters and blanks interiors, so in
 * the masked text the next same-kind quote after an opening one is its closer.
 * A template with a `${…}` hole is not a fixed string and is skipped.
 */
function literalsIn(
  src: string,
  masked: string,
  from = 0,
  to = masked.length,
): Literal[] {
  const out: Literal[] = [];
  for (let i = from; i < to; i++) {
    const q = masked[i]!;
    if (!QUOTES.has(q)) continue;
    const close = masked.indexOf(q, i + 1);
    if (close < 0) break;
    const value = src.slice(i + 1, close);
    if (!(q === "`" && value.includes("${"))) out.push({ start: i + 1, value });
    i = close;
  }
  return out;
}

/** Calls whose FIRST argument is a module specifier: dynamic `import("…")`,
 *  `vi.mock("…")` / `mock.module("…")`. */
const SPECIFIER_CALLS = ["import", "mock", "module"] as const;

/**
 * Offsets (just inside the quote) of every module specifier in a source: the
 * static `import`/`export … from` ones, and the first argument of each call in
 * `SPECIFIER_CALLS`. Read structurally, so an import written inside a string
 * (a test fixture's sample source) is not one.
 */
function specifierStarts(src: string, masked: string): Set<number> {
  const starts = new Set<number>(findImports(src).map((i) => i.index));
  for (const marker of SPECIFIER_CALLS) {
    for (const span of markerCallSpans(masked, marker)) {
      const m = /^\s*(["'`])/.exec(masked.slice(span.open + 1, span.close));
      if (m) starts.add(span.open + 1 + m[0].length);
    }
  }
  return starts;
}

/**
 * `path` refs in one TS/TSX source: every string literal that is wholly a
 * `plugins/…` path, and every `@plugins/…` module specifier (static, dynamic
 * and mocked imports). The range spans exactly the plugin directory
 * (`plugins/a/plugins/b`) — for a specifier, starting after its `@`.
 *
 * A `@plugins/…` string that is NOT in a specifier position is not a ref: test
 * fixtures spell fake specifiers (`"@plugins/a/web"`) as data by the dozen.
 */
export function scanPathRefs(file: string, src: string): PathRef[] {
  if (!src.includes(`${PLUGINS_DIR}/`)) return [];
  const masked = maskSource(src);
  const specifiers = src.includes(SPECIFIER_PREFIX)
    ? specifierStarts(src, masked)
    : new Set<number>();
  const lineOf = lineIndex(src);
  const out: PathRef[] = [];
  for (const lit of literalsIn(src, masked)) {
    const specifier = lit.value.startsWith(SPECIFIER_PREFIX);
    if (specifier && !specifiers.has(lit.start)) continue;
    const pathText = specifier ? lit.value.slice(1) : lit.value;
    const under = pluginPathFromLiteral(pathText);
    if (under == null) continue;
    const value = `${PLUGINS_DIR}/${pluginDirPrefix(under)}`;
    const start = lit.start + (specifier ? 1 : 0);
    const range = { start, end: start + value.length };
    assertRange(file, src, range, value);
    out.push({
      kind: "path",
      syntax: specifier ? "specifier" : "literal",
      file,
      range,
      line: lineOf(start),
      value,
    });
  }
  return out;
}

/**
 * The string argument of every `asPluginId("…")` call. Only a call whose whole
 * argument list is one fixed string counts — `asPluginId(x)` names no plugin
 * here. The empty id (`asPluginId("")`, the tree's root sentinel) names none
 * either.
 */
export function scanAsPluginIdRefs(file: string, src: string): DotRef[] {
  if (!src.includes("asPluginId")) return [];
  const masked = maskSource(src);
  const lineOf = lineIndex(src);
  const out: DotRef[] = [];
  for (const span of markerCallSpans(masked, "asPluginId")) {
    const args = masked.slice(span.open + 1, span.close);
    if (!/^\s*(["'`])\s*\1\s*,?\s*$/.test(args)) continue;
    const [lit] = literalsIn(src, masked, span.open + 1, span.close);
    if (!lit || lit.value === "") continue;
    const range = { start: lit.start, end: lit.start + lit.value.length };
    out.push({
      kind: "dot",
      site: "as-plugin-id",
      file,
      range,
      line: lineOf(lit.start),
      value: lit.value,
      id: asPluginId(lit.value),
    });
  }
  return out;
}

/** The boundary zone every plugin node is prefixed with in a runtime exception. */
const ZONE_PREFIX = "plugin.";
const FOLDERS = new Set<string>(PLUGIN_FOLDERS);

/**
 * Both sides of every entry of the `runtimeExceptions: [ … ]` array in a
 * boundary config source (`"plugin.<id>.<folder> -> plugin.<id>.<folder>"`,
 * read through the boundary checker's own `parseRuntimeException`). The range
 * spans the plugin id alone.
 */
export function scanRuntimeExceptionRefs(file: string, src: string): DotRef[] {
  const masked = maskSource(src);
  const key = /\bruntimeExceptions\s*:\s*\[/.exec(masked);
  if (!key) {
    throw new Error(
      `plugin-refs: ${file} has no \`runtimeExceptions: [\` array`,
    );
  }
  const open = key.index + key[0].length - 1;
  const close = matchBracket(masked, open, "[", "]");
  if (close < 0)
    throw new Error(`plugin-refs: ${file}: unbalanced runtimeExceptions`);
  const lineOf = lineIndex(src);
  const out: DotRef[] = [];
  for (const lit of literalsIn(src, masked, open + 1, close)) {
    const { source, target } = parseRuntimeException(lit.value);
    const sides: Array<[string, number]> = [
      [source, lit.value.indexOf(source)],
      [target, lit.value.lastIndexOf(target)],
    ];
    for (const [side, at] of sides) {
      const folder = side.slice(side.lastIndexOf(".") + 1);
      if (!side.startsWith(ZONE_PREFIX) || !FOLDERS.has(folder)) {
        throw new Error(
          `plugin-refs: ${file}:${lineOf(lit.start)}: runtime exception side "${side}" is not "${ZONE_PREFIX}<plugin id>.<folder>"`,
        );
      }
      const id = side.slice(ZONE_PREFIX.length, -(folder.length + 1));
      const start = lit.start + at + ZONE_PREFIX.length;
      const range = { start, end: start + id.length };
      assertRange(file, src, range, id);
      out.push({
        kind: "dot",
        site: "runtime-exception",
        file,
        range,
        line: lineOf(start),
        value: id,
        id: asPluginId(id),
      });
    }
  }
  return out;
}

/** The manifest fields whose array elements are entry patterns naming plugins. */
const MANIFEST_FIELD_RE = /\b(?:entryPoints|selectedContributors)\s*:\s*\[/g;

/**
 * Every plugin id in the compositions manifest's SOURCE (the `defineConfig`
 * seeds its `.origin.jsonc` is generated from): each string literal in the
 * array literal of an `entryPoints:` / `selectedContributors:` property, read
 * through the closure engine's `parseEntryPattern`. The range spans the base id,
 * so `!` and `.**` survive a rewrite; the root pattern `**` names no plugin.
 *
 * An id written anywhere else in that file (a helper argument, a const array)
 * is invisible here — the `plugin-refs:compositions-source-covers-origin` check
 * fails on it, since the generated origin still names it.
 */
export function scanCompositionSourceRefs(file: string, src: string): DotRef[] {
  const masked = maskSource(src);
  const lineOf = lineIndex(src);
  const out: DotRef[] = [];
  for (const m of masked.matchAll(MANIFEST_FIELD_RE)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open, "[", "]");
    if (close < 0) {
      throw new Error(
        `plugin-refs: ${file}:${lineOf(open)}: unbalanced manifest array`,
      );
    }
    for (const lit of literalsIn(src, masked, open + 1, close)) {
      const parsed = parseEntryPattern(lit.value);
      if (parsed.kind === "root") continue;
      const start = lit.start + (parsed.negate ? 1 : 0);
      const range = { start, end: start + parsed.base.length };
      assertRange(file, src, range, parsed.base);
      out.push({
        kind: "dot",
        site: "composition-source",
        file,
        range,
        line: lineOf(start),
        value: parsed.base,
        id: parsed.base,
      });
    }
  }
  return out;
}
