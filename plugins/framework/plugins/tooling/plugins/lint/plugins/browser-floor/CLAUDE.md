# browser-floor

The oldest browsers equin's browser code runs on, and the rule that holds it.

## The floor

`BROWSER_FLOOR` (`lint/browser-floor.ts`): **Chrome / Edge 111, Firefox 115,
Safari / iOS Safari 16.4** — every browser from March 2023 on (Firefox: its
115 extended-support release). It keeps iOS 16, the last iOS of the iPhone 8
and X: equin.ai is public, and on 2026-11-19 a visitor's older Safari crashed
its home page on `URL.canParse` (Safari 17).

The floor is about **APIs** and **regular expressions**. Other syntax is
lowered by vite's default build target (`baseline-widely-available`: Chrome
107, Safari 16), already below it — but no build lowers a regex flag or
pattern syntax (see below).

## `browser-floor/no-api-above-floor`

Type-aware. In a browser-built file — a plugin's `web/`, `core/`, `shared/`,
`exhibits/` — every member access and global whose declaration is a global
built-in (TypeScript's lib, or a package's global types such as Bun's) is
looked up in MDN's `@mdn/browser-compat-data`; one a floor browser lacks is
reported, naming the browsers and versions. `tsc` cannot catch these: the lib
declares the newest built-ins whatever browsers visitors run.

- Only property names the data lists as newer than the floor are resolved
  (the syntactic gate), so the checker is asked about few accesses.
- A member of a newer owner is not listed: it is reached through the owner
  (its constructor, or a newer member), which is reported.
- **A use behind a feature test passes**: `typeof X` / `"name" in obj` /
  a plain read in the test of an `if` or `?:` whose branch holds the use, the
  left of an `&&` before it, an early `return` / `throw` on it, `x.newer?.()`,
  and a read on the left of `??` / `||`. A test far from its use (a flag
  computed elsewhere) is not seen: disable that line naming the guard.
- Fix a hit with the floor-safe spelling in
  [`packages/floor-compat`](../../../../../../../packages/plugins/floor-compat/CLAUDE.md)
  (`canParseUrl`, `parseUrl`, `jsonResponse`, `promiseWithResolvers`), or
  feature-test it and keep a fallback.

Not covered: a member reached by a computed key or destructuring.

**Regular expressions too.** A regex literal, or `new RegExp(source, flags)`
with literal flags, is parsed with regexpp (`lint/regexp-features.ts`): each
flag is checked as its `RegExp` member (`v` → `unicodeSets`, Safari 17) and
the pattern's syntax against `javascript.regular_expressions.*` (modifiers
`(?i:…)`, duplicate named groups) — the same data, so raising the floor
updates it too. A regex above the floor throws where it is CREATED: a literal
is a parse error of the module, the constructor throws "Invalid flags supplied
to RegExp constructor" at module evaluation — and every importer fails to load
(equin.ai's page editor did on emoji's `v` regex, 2026-11-19). A flag behind a
test of its member (`"unicodeSets" in RegExp.prototype ? … : fallback`)
passes. Not covered: the syntax of a computed source, and computed flags. npm
code is not linted — `browser-floor:vendor-sets` (below) holds it as built.
`regexp-above-floor.ts` is the one verdict both read.

The syntax note above ("lowered by vite") holds for syntax esbuild can lower;
regex flags and syntax it cannot, so they are held here.

## `browser-floor:worker-closure` — the server code a browser runs

A browser host (the website demo's in-browser server) boots plugins'
`server/` code in a visitor's browser worker, so a newer built-in there
crashes the demo just as one in `web/` does. Which server files ship is a fact
of the host's whole closure, which a per-file rule cannot see — and a server
file no browser loads must stay free to use newer built-ins. So the check
(`check/index.ts`):

- takes the closure off the shared module graph (plugin-records'
  `fileSetClosure`): every module each `bin/browser-host.ts`
  (codegen's `discoverBrowserHosts`) loads — static imports and `import()`s,
  minus the browser-unreachable ones (web-artifacts'
  `isBrowserUnreachableDynamic`, the edges the worker closure skips);
- runs this rule, with `{ shipsToBrowser: true }`, on the modules of it
  outside the browser-built folders (its `server/` and `bin/` files, ~1.3k),
  typed under the repo's compiler options, in a subprocess
  (`lint/worker-closure-probe.ts`: a ~4k-file compile, a few seconds, kept
  off the check runner's shared thread);
- is input-keyed: the closure's module reads and every file the compile read
  are its read-set, so an edit outside them replays the pass.

An inline `eslint-disable` for this rule in a `server/` file would be an
unused directive to the type-check lint (which skips server files): fix a hit
with `floor-compat` or a feature test.

## `browser-floor:vendor-sets` — the npm code a browser runs

npm packages reach the page through the vendor set (`set.<hash>` in
web-artifacts' store, named by the import map) and a browser host's worker
through its tree's `_vendor/` — a link to the same set. No lint sees them, and
no build can fix a regex: esbuild's `target` lowers syntax, but a regex flag or
pattern syntax the target lacks only turns a literal into `new RegExp(…)`,
which throws the same on a floor browser. So a dependency upgrade bringing a
`v` flag, `(?i:…)` modifiers or duplicate named groups would break every page
importing that package there. (APIs newer than the floor in npm code are not
covered: libraries feature-test them, and untyped minified code cannot tell a
guarded use from a bare one.)

The check (`check/vendor-sets.ts`) parses every set of the host's store —
its entry files and `chunks/` — in a subprocess
(`lint/vendor-scan-probe.ts`, the pure half `lint/vendor-scan.ts`): each regex
literal and `new RegExp(…)` with literal flags gets `regexpAboveFloor`'s
verdict; one created inside a `try` (a feature test) or behind a test naming
its flag's member passes. A hit names the npm file it came from (the chunk's
sourcemap) and every set holding it; fix it by pinning the package, patching
it (`bun patch`), or keeping it behind a feature test in our own code.

- **Host-scoped**: the store is the machine's. Main's hourly host audit runs
  it and files a report; `./equin check --scope host` runs it on demand. Not
  deploy-scoped: a build's check pass sees the dist that build replaces, so a
  failure there would block the build fixing it.
- **Memoized per set** (`data-dirs`: `browser-floor-vendor-scans/<set>.json`,
  under the scanner's digest — this folder's verdict code and the compat data,
  regexpp and TypeScript versions). A set is write-once, so it is parsed once;
  a new set's files are first matched by content hash against every kept memo
  (about half of a new set's files: its chunks' bytes name each other's
  hashed names). A memo whose set was pruned is deleted. Measured 2026-11-19
  (68 sets, ~31 MB / 668 files / ~3.7k regexes each): every set cold, 26 s;
  one new set, under a second to ~2 s; nothing new, ~0.2 s.
- It does not touch web-artifacts' `core/`: that source is the builder's
  identity, so any edit there rebuilds the whole fleet cold.

Raising the floor is a one-line edit of `BROWSER_FLOOR`; the rule then stops
reporting what the new floor has.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The browser floor equin's browser code supports (Chrome/Edge 111, Firefox 115, Safari and iOS Safari 16.4 — every browser from March 2023 on), and browser-floor/no-api-above-floor: a type-aware rule that refuses, in browser-built code, a built-in the TypeScript lib declares but MDN's browser-compat-data says a floor browser lacks (URL.canParse, Set.prototype.union, Promise.withResolvers, …); and the browser-floor:worker-closure check, which runs that rule on the server/ and bin/ modules a browser host's worker loads (the closure of each bin/browser-host.ts — the website demo's in-browser server), so server code a visitor's browser runs is held to the floor too; and the browser-floor:vendor-sets host check, which holds the npm code the vendor sets bundle (every set in the web-artifact store, memoized per set) to the floor's regular expressions — no v flag, (?i:…) modifiers or duplicate named groups outside a feature test.

<!-- AUTOGENERATED:END -->
