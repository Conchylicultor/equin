import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

/**
 * A half-open span `[start, end)` of UTF-16 offsets into the file's text — the
 * units `String.prototype.slice` takes. `text.slice(start, end) === ref.value`
 * always holds, so a rewriter can apply every edit of one file back-to-front
 * (highest `start` first) without re-locating anything.
 */
export interface RefRange {
  start: number;
  end: number;
}

interface RefBase {
  /** Repo-relative path of the file the reference is written in. */
  file: string;
  /** Exactly the characters that name the target — nothing around them. */
  range: RefRange;
  /** 1-based line of `range.start`, for reporting. */
  line: number;
  /** The text at `range`. */
  value: string;
}

/**
 * How a `path` ref is spelled:
 *  - `literal` — a whole string literal that is a `plugins/…` path (optionally a
 *    trailing `/` or glob): `resolveFrom`, lint/check allowlists, fixtures.
 *  - `specifier` — an `@plugins/…` string literal (import specifiers, dynamic
 *    `import()`, `vi.mock(…)`). The range starts AFTER the `@`.
 */
export type PathRefSyntax = "literal" | "specifier";

/**
 * A plugin named by its filesystem path. `value` is always the plugin DIRECTORY,
 * `plugins/<a>/plugins/<b>` — the longest plugin-dir prefix of the literal (the
 * part after it, `/web/x.tsx` or `/**`, is outside the range). Replacing the
 * range with the new plugin dir is the whole rewrite.
 */
export interface PathRef extends RefBase {
  kind: "path";
  syntax: PathRefSyntax;
}

/**
 * Where a `dot` ref was found. Each site is read STRUCTURALLY (a parsed JSONC
 * node, a call's argument, a named array's element) — never by a free-text
 * regex, since a top-level id like `search` has no dot to recognise it by.
 *  - `composition-manifest` — an `entryPoints` / `selectedContributors` entry of
 *    the compositions manifest (range: the id, without `!` / `.**`).
 *  - `composition-source` — the same entries in the manifest's SOURCE, the
 *    `defineConfig` seeds the origin is generated from (an `entryPoints:` /
 *    `selectedContributors:` property's array literal).
 *  - `reorder-items` — the `<pluginId>` half of a reorder override's
 *    `"<pluginId>:<id>"` `items` entry, in any tracked `config/**.jsonc`.
 *  - `as-plugin-id` — the string argument of `asPluginId("…")` in non-test code.
 *  - `runtime-exception` — either side of a boundary-config `runtimeExceptions`
 *    entry (range: the id, without the zone prefix and folder suffix).
 */
export type DotRefSite =
  | "composition-manifest"
  | "composition-source"
  | "reorder-items"
  | "as-plugin-id"
  | "runtime-exception";

/** A plugin named by its dot-form id. `value === id`. */
export interface DotRef extends RefBase {
  kind: "dot";
  site: DotRefSite;
  id: PluginId;
}

/**
 * How a `relative` ref is spelled:
 *  - `md-link` — `[x](rel)` / `![x](rel)`;
 *  - `md-definition` — a `[x]: rel` reference definition;
 *  - `html-attr` — `<img src="rel">` / `<a href="rel">` inside markdown;
 *  - `css-source` / `css-import` — `@source "rel"` / `@import "rel"`.
 */
export type RelativeRefSyntax =
  "md-link" | "md-definition" | "html-attr" | "css-source" | "css-import";

/**
 * A path relative to the file it is written in. `value` is the path part only
 * (a `#anchor` / `?query` suffix is outside the range, so a rewrite keeps it).
 * Resolve it with `resolveRelativeRef`; rebuild it from a new location with
 * `relativeLinkFrom`.
 */
export interface RelativeRef extends RefBase {
  kind: "relative";
  syntax: RelativeRefSyntax;
  /** True when `value` contains a glob (`*`, `?`, `{`, `[`) — CSS `@source` only. */
  glob: boolean;
}

export type PluginRef = PathRef | DotRef | RelativeRef;
export type PluginRefKind = PluginRef["kind"];
