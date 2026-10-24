# Pin the jsdom test locale (and timezone)

## Context

`./equin test plugins/page` fails in agent sessions with no code change.
The date-chip test in `plugins/page/plugins/read-only-view/web/__tests__/runs-renderer.test.tsx`
expects `Jun 17` and gets `M06 17, Wed`. The formatter
(`plugins/page/plugins/inline-date/web/internal/format-date.ts`) formats with
the default locale, which is correct in production because it should follow the
viewer. The session has `LANG=C.UTF-8`, so ICU falls back to the root locale
`und`.

`test/setup.ts` pins the clock so that no jsdom suite can depend on the day it
runs. Nothing pins the locale, so a suite passes or fails depending on who runs
it. The timezone has the same gap: `TEST_NOW` is "local noon", and `TZ` is not
pinned anywhere.

Measured constraint: the default locale is read when the process starts.
`process.env.LC_ALL = …` inside a running Node process leaves
`Intl.DateTimeFormat().resolvedOptions().locale` at `und`. A child process
started with `LC_ALL=en_US.UTF-8` resolves `en-US`. So the pin has to be in the
environment of the process that runs the tests, not in the setup file.

## Where the pin goes

Vitest 4.1.4's default `forks` pool starts every test worker with
`child_process.fork(entry, [], { env })`. That `env` is
`{ ...process.env, ...options.env, ...config.env, ...project.config.env }`
(`node_modules/vitest/dist/chunks/cli-api.*.js`). So `test.env` in
`vitest.config.ts` becomes the **startup** environment of every worker. That is
exactly the shape we need.

Putting it in the config, rather than in `./equin test`'s spawn env,
covers every way vitest runs: `./equin test`, `bun run test:dom`, and a
bare `vitest`. The config is the one place every run goes through.

## Changes

1. **`vitest.config.ts`**
   - Add `test.env: { LC_ALL: "en_US.UTF-8", TZ: "UTC" }`, with a comment
     explaining that this is the startup environment of each fork. The locale
     cannot be pinned from `setup.ts` for the reason above.
   - Set `pool: "forks"` explicitly. The `threads` pool shares the parent
     process, so its ICU default was already resolved when that process started.
     With `threads`, the `env` pin would silently do nothing.
   - `TZ` choice: `UTC` is the neutral default. The full jsdom suite gets run
     under it (see Verification). If it turns up tests that only passed in the
     author's timezone, fix those tests; don't pick a timezone to hide them.

2. **`test/setup.ts`** — add a loud runtime assert (rung 4) next to the clock
   pin. If `new Intl.DateTimeFormat().resolvedOptions()` is not `locale: "en-US"`
   and `timeZone: "UTC"`, throw an error that names the cause. That covers a
   worker started without the config's env: a threads pool, a custom runner
   invocation, or a future vitest change to how it spawns workers. That run then
   fails on its first line instead of producing locale-dependent reds. Also
   extend the header comment: pinned clock + locale + timezone, and why the
   locale half lives in the config.

3. **`test-layout` plugin** (`plugins/framework/plugins/tooling/plugins/test-layout/`)
   - `core/test-layout.ts`: add `DOM_TEST_LOCALE_PIN` (the `LC_ALL` literal) and
     `DOM_TEST_TZ_PIN`, next to `DOM_TEST_CLOCK_PIN`.
   - `check/index.ts`: add **rule (g)**, the same comment-stripped substring
     assert as (d)/(f). It fails if `vitest.config.ts` no longer carries the
     `env` pin and `pool: "forks"`. The failure message explains that without
     them, jsdom results depend on the runner's `LANG`.
   - `CLAUDE.md`: add a short "The jsdom locale and timezone are pinned (rule g)"
     section: why it's in the config and not the setup file, why forks, and that
     the setup file asserts it.

4. **Root `CLAUDE.md` → Testing**: extend the "pinned clock" sentence to "pinned
   clock, locale (en-US) and timezone (UTC)".

Not changed: `format-date.ts`. Using the viewer's default locale is the intended
production behavior. The test environment was the bug.

## Out of scope / follow-up

- **bun:test** suites also run `Intl` in-process, and nothing pins their locale.
  `bunfig.toml`'s preload runs too late to pin it, for the same reason as above.
  If wanted, the equivalent is the spawn env in
  `plugins/framework/plugins/cli/plugins/test/cli/run.ts`, but a bare `bun test`
  would still skip it. File as a task rather than widen this change.

## Verification

1. Before: `LANG=C.UTF-8 LC_ALL= ./equin test plugins/page/plugins/read-only-view`
   is red (reproduces the report).
2. After: the same command is green. It is also green with `LC_ALL=fr_FR.UTF-8`
   and `TZ=Pacific/Kiritimati` set in the calling shell. That proves the config
   pin wins over the caller's environment.
3. `./equin test` (the whole repo) under `LANG=C.UTF-8`. This surfaces any
   other latent locale or timezone dependents. Fix the ones that fail.
4. Temporarily set `pool: "threads"` and confirm that `setup.ts` throws the named
   error. Then revert.
5. Temporarily delete the `env` line and confirm that
   `./equin check test-layout:runner-split` fails with rule (g). Then
   revert.
6. `./equin check` is all green (plugin docs in sync).
