# test-layout

Owns the bun:test ⇄ vitest split as data (`core/`) and enforces it
(`check/index.ts`, id `test-layout:runner-split`). One plugin, so the constants
and their enforcement cannot separate.

| lives at | runner | scoped by |
| --- | --- | --- |
| `*.test.ts(x)` next to its source | `bun test` | `bunfig.toml` → `pathIgnorePatterns = ["**/web/__tests__/**"]` |
| `plugins/<…>/web/__tests__/*.test.ts(x)` | `vitest` | `vitest.config.ts` → `include: ["plugins/**/web/__tests__/**/*.test.{ts,tsx}"]` |

**The two globs must stay exact complements.** The bun ignore is deliberately
`**/web/__tests__/**` and not the looser `**/__tests__/**`: under the loose
glob a stray `core/__tests__/foo.test.ts` is ignored by bun and unmatched by
vitest's `plugins/`-anchored include — in neither runner's scope, silently never
run. Rule **c** rejects it instead.

They are also **not** each other's negation: the ignore is unanchored, the
include is anchored at `plugins/`, so `cli/web/__tests__/x.test.ts` is excluded
by both. Hence `isBunTestPath` is written out rather than derived as
`!isDomTestPath`, and `partitionTestPaths` returns an `orphan` bucket rather
than folding leftovers into `bun` — a green run for tests that never executed is
the exact failure this plugin prevents.

## No hand-built DOM in a bun:test file (rule e)

`bun test` has no DOM. A suite for a DOM-bound module therefore has exactly one
home — the plugin's `web/__tests__/`, where vitest hands it jsdom, whole. Rule
**e** rejects the other move: installing `window` / `document` / `sessionStorage`
/ … on `globalThis` from a file bun:test runs (`core/fake-dom.ts` holds the name
set and the detector; `core/fake-dom.test.ts` its fixtures).

The ban is not tidiness. Runtime-agnostic code guards on
`typeof window === "undefined"` — a **presence** test — so a stub like
`window = { sessionStorage }` walks past every one of those guards and then
throws on the first member it does not carry, inside some module the suite is not
even about. Widening the stub only moves that edge; jsdom is already the complete
one. So: move the suite, never grow the stub.

The detector reads `maskSource`d text, so an install inside a comment or a string
is not code and is not reported — which is what lets `core/fake-dom.test.ts`
spell out the banned idiom as fixtures without reporting itself.

## The jsdom clock is pinned (rule f)

Every vitest suite starts on a fixed instant — Monday 15 June 2026, local noon —
pinned in the shared setup `test/setup.ts`, which runs before the test module is
evaluated, so module-scope `new Date()` constants are pinned too. A jsdom test
must not be able to depend on the day it runs on: such a suite is green for a
month and red the next, for everyone, with nothing in the diff to blame.

Only `Date` is faked and it still ticks (`shouldAdvanceTime`) — timers,
`waitFor`, real async and React's scheduling are untouched. The origin is pinned,
not the flow of time. It goes through `vi.useFakeTimers` and not a bare
`vi.setSystemTime`, because the latter swaps in a `Date` subclass with no
`Symbol.hasInstance`, and every `Date` built before the swap then stops being
`instanceof Date`.

The pin is a **floor**. A suite asserting on "today" (`aria-current="date"`, the
Today/Tomorrow presets) still pins its own instant with `vi.setSystemTime(...)`,
as `date-picker`'s `calendar-grid.test.tsx` does; a file installing its own fake
timers overrides the shared pin entirely.

Rule **f** keeps the pin from being deleted: the setup file exists and still
contains `vi.setSystemTime(TEST_NOW)` — the same comment-stripped substring
assert as **d**, so it guards the statement and not the prose explaining it.

## The jsdom locale and timezone are pinned (rule g)

Every jsdom worker runs in locale `en-US` and timezone `UTC`. Code that formats
with the default locale (`toLocaleDateString(undefined, …)`) is right in the app,
where it follows the viewer. Without the pin, a test of that code passes or fails
depending on who runs it. `LANG=C.UTF-8`, the norm in agent sessions and CI,
resolves the ICU root locale `und` and renders `M06 17` where a laptop renders
`Jun 17`. The timezone rides along because the pinned clock is "local noon".

The pin cannot live beside the clock. A process reads its default locale once,
when it starts, so assigning `process.env.LC_ALL` in the setup file changes
nothing. It lives in `vitest.config.ts` instead, as `test.env`: vitest starts
every fork with that as its environment. `pool: "forks"` is named explicitly,
because a `threads` worker shares the parent process, whose locale was fixed
before the config was read. The setup file then asserts the pin arrived, and
throws before any suite runs if it did not.

Rule **g** keeps the pin from being deleted. `vitest.config.ts` must still
contain the `pool`, `LC_ALL` and `TZ` directives (the values are in `core/`),
checked with the same comment-stripped substring assert as **d** and **f**.

**Why a check, not a lint rule.** Rule files are dual-loaded under jiti, which
cannot resolve `@plugins/*` — a rule could not import `core/` and would have to
duplicate the two literals plus add an in-sync check to keep the copies honest.
Rule **d** (the config files still contain the literals; each failure message
names the *other* file) is out of ESLint's reach anyway, and it is the
load-bearing one: a–c guard today's files, while **d**, **f** and **g** stop the fixes
themselves from being quietly deleted later. Rule **d** strips comments before
the substring assert — both config files explain the pair in a comment that
quotes the literal, so a whole-file `includes` would keep passing after the live
directive was deleted.

The check is **not** `inputKeyed` — it discovers files via `git ls-files` and
reads the two config files directly, so its reads bypass the recording
`FileSystemView` and an input-keyed PASS could go stale.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The canonical bun:test ⇄ vitest split as data (core), enforced as the test-layout:runner-split check.
- Core:
  - Uses: `plugin-meta/parse-utils.maskSource`
  - Exports (values):
    - `BUN_TEST_IGNORE`
    - `DOM_TEST_CLOCK_PIN`
    - `DOM_TEST_INCLUDE`
    - `DOM_TEST_LC_ALL`
    - `DOM_TEST_LOCALE`
    - `DOM_TEST_POOL`
    - `DOM_TEST_SETUP_FILE`
    - `DOM_TEST_TIME_ZONE`
    - `isBunTestPath`
    - `isDomTestPath`
    - `isTestFilePath`
    - `partitionTestPaths`
    - `TEST_FILE_GLOB`
- Exemptions:
  - Exempts itself from: `marker-scan-safety/no-adhoc-marker-scan` — `check/index.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
