# plugin-refs

The one place that knows **where the repo names a plugin**. `findPluginRefs(repo)`
returns every such reference, each with the file, an exact character range and the
text at it. Two consumers share it:

- **checks** resolve every ref (`plugin-refs-resolve` for path/dot refs,
  `plugin-refs:relative-links-resolve` here for relative links);
- **a mover** (`./equin plugin move`, planned in
  [`research/2026-09-23-global-plugin-relocation.md`](../../../../research/2026-09-23-global-plugin-relocation.md))
  rewrites them.

Because both read one list, a reference the mover would miss is one the check
never validated either. Add a new kind of reference site HERE, never as a
private scan in a check.

## Three kinds

| kind | what | where it is found |
| --- | --- | --- |
| `path` | `plugins/a/plugins/b` | a string literal that is wholly a `plugins/…` path; a `@plugins/…` module specifier (static / dynamic `import()` / `mock(…)`); in a lint rule's own source (non-test code under a plugin's `lint/`), a specifier-shaped `@plugins/…` string — the import source the rule matches (`rule-source`, carrying the `barrel` that must hold an `index.ts`) — in every `.ts`/`.tsx` except `*.generated.ts` |
| `dot` | `a.b` | compositions manifest `entryPoints` / `selectedContributors` (via `parseEntryPattern`), in the generated origin and in its `defineConfig` source (`composition/core/config.ts`: the array literal of an `entryPoints:` / `selectedContributors:` property — `plugin-refs:compositions-source-covers-origin` fails on an id spelled any other way); reorder `items` keys in `config/**.jsonc`; `asPluginId("…")` in non-test code; boundary-config `runtimeExceptions` (via `parseRuntimeException`) |
| `relative` | `../x/CLAUDE.md` | markdown `[x](rel)`, `[x]: rel`, `<img src>` / `<a href>` in every `*.md`; CSS `@source` / `@import` |

- **Dot refs are read structurally, never by free-text regex.** A top-level id
  like `search` has no dot, so a regex over prose cannot tell it from a word — and
  a mover rewriting prose would corrupt it. Each site parses the structure the id
  lives in (a JSONC node, a call argument, a named array's element). (Free text
  is searched only for KNOWN names — see Mentions below.)
- **`@plugins/…` counts only in a specifier position** — or as a lint rule's
  data. Test fixtures spell fake specifiers as data (`"@plugins/a/web"`);
  `findImports` and the call scan see the real ones only. A rule's own source is
  the exception: the string it compares an import against names a real barrel,
  and a stale one makes the rule silently catch nothing (`no-adhoc-caret-trigger`
  matched `floating-surface`'s pre-move path for two months), so
  `plugin-refs-resolve` checks its barrel and a mover rewrites it. A rule may not
  hide a plugin inside a regex instead (`rule-kind-safety/no-plugin-path-regex`).
- **The range is the plugin part only.** A path ref's range is the plugin dir
  (`/web/x.tsx` and `/**` are outside it; for a specifier it starts after `@`); a
  dot ref's range is the id (`!`, `.**`, `:slot`, the `plugin.` zone and the
  `.core` folder are outside it); a relative ref's range excludes `#anchor` /
  `?query`. So the rewrite is always "replace the range", applied back-to-front
  per file.

## Mentions: known names in free text

`findPluginMentions(repo, ids)` is the other half: every place a GIVEN set of
plugins is written in any text file — a comment, a lint message, a test
fixture, a specifier held as data (`LIVE_STATE_CORE =
"@plugins/…/live-state/core"`, which the resource scanners match imports
against and nothing else validated), prose. Two spellings: the path
`plugins/a/plugins/b` (inside `@plugins/…` too; nothing path-like may sit
before it, nothing extending its last segment after it) and, for an id with a
dot, the dot id `a.b`. A mention inside a markdown/CSS relative link's target is
not one (that is a `relative` ref). Nothing is excluded by policy — each
consumer drops what it does not own (research, derived files).

Free text is safe here only because the caller names the plugins: a fixture's
fake `plugins/a/web` is never looked for, and a mention is never *resolved*.
Consumers:

- the mover asks for the plugin it moves, rewrites the **path** mentions no ref
  covers, and only reports the **dot** ones (a dot id can be a stored identity);
- `relocate:moved-plugins-unnamed` asks for every plugin the move ledger moved
  away, and fails on any mention left.

## Helpers for a mover

- `pluginDirOfRef(ref)` — the plugin dir a path/dot ref names; test it against
  the moved subtree with `isWithinDir`.
- `resolveRelativeRef(ref)` — the repo path a relative ref points at (`inside`,
  with the `staticPath` that must exist for a glob) or `outside` the repo.
- `relativeLinkFrom(sourceFile, target)` — the inverse: what to write in
  `sourceFile` to point at `target`. Re-relativizing a moved link is
  `resolveRelativeRef` against the old location, map the target through the move,
  `relativeLinkFrom` the new location.
- `pluginDirOfPath(path)` — the plugin dir a repo path sits in (path grammar
  only).

## Relative links check

`plugin-refs:relative-links-resolve`: every relative markdown target exists (file
or directory); a CSS glob's static prefix exists. Sources under `research/` are
not checked — dated records whose targets are legitimately deleted later — but
links **into** research from anywhere else are.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The one plugin-reference locator: every place the repo names a plugin (path literals, @plugins specifiers, structurally-read dot ids, relative markdown/CSS links), each with an exact character range a mover rewrites by.
- Core:
  - Uses:
    - `framework/plugin-id.asFsPath`
    - `framework/plugin-id.asPath`
    - `framework/plugin-id.asPluginId`
    - `framework/plugin-id.isTestCodePath`
    - `framework/plugin-id.PLUGIN_FOLDERS`
    - `framework/plugin-id.PluginId`
    - `framework/tooling/boundaries.parseRuntimeException`
    - `packages/macrotask-yield.createTimeSlicer`
    - `plugin-meta/closure.parseEntryPattern`
    - `plugin-meta/parse-utils.findImports`
    - `plugin-meta/parse-utils.markerCallSpans`
    - `plugin-meta/parse-utils.maskSource`
    - `plugin-meta/parse-utils.matchBracket`
  - Exports (types):
    - `DotRef`
    - `DotRefSite`
    - `FindPluginRefsOptions`
    - `PathRef`
    - `PathRefSyntax`
    - `PluginMention`
    - `PluginRef`
    - `PluginRefKind`
    - `RefRange`
    - `RelativeRef`
    - `RelativeRefSyntax`
    - `ResolvedRelativeRef`
  - Exports (values):
    - `BOUNDARY_CONFIG`
    - `COMPOSITIONS_MANIFEST`
    - `COMPOSITIONS_SOURCE`
    - `findPluginMentions`
    - `findPluginRefs`
    - `isWithinDir`
    - `maskMarkdown`
    - `pluginDirOfPath`
    - `pluginDirOfRef`
    - `pluginDirPrefix`
    - `pluginPathFromLiteral`
    - `relativeLinkFrom`
    - `resolveRelativeRef`
    - `scanAsPluginIdRefs`
    - `scanCompositionManifestRefs`
    - `scanCompositionSourceRefs`
    - `scanReorderItemRefs`
    - `scanRuntimeExceptionRefs`
- Cross-plugin:
  - Imported by: `plugin-meta/relocate`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/resolve.ts` (debt)
- Test helpers:
  - Core: `@plugins/plugin-meta/plugins/plugin-refs/core/testing`
    - `mentionScanner` — The per-file half of `findPluginMentions`: a scanner for the mentions of `ids` in one file's text (none in a binary one), in offset order.
    - `scanCssRefs` — Relative paths in one CSS source: `@source "rel"` (and `@source not "rel"`) and `@import "rel"`.
    - `scanMarkdownRefs` — Relative targets in one markdown source: `[x](rel)` / `![x](rel)`, `[x]: rel` definitions, and `<img src>` / `<a href>` attributes.
    - `scanPathRefs` — `path` refs in one TS/TSX source: every string literal that is wholly a `plugins/…` path, and every `@plugins/…` module specifier (static, dynamic and mocked imports).

<!-- AUTOGENERATED:END -->
