# Per-plugin checks & ESLint rules

## Context

`./equin check` runs a hand-edited flat array of `Check` objects (`cli/src/checks/index.ts`). All checks live in the CLI today; plugins can't contribute their own. We want plugins to define lint rules and custom checks locally, in `plugins/<name>/lint/` (real ESLint rules) and `plugins/<name>/check/` (our existing `Check` interface), and have them auto-discovered at runtime — no codegen, no hand-edited registry. ESLint isn't installed today; we add it.

## Approach

### A. Two folders, two contracts

- `plugins/<name>/lint/index.ts` — ESLint plugin object: `{ name: "<plugin-id>", rules: Record<string, RuleModule> }`. Matches ESLint v9 flat-config plugin shape.
- `plugins/<name>/check/index.ts` — default-exports `Check | Check[]` (existing `cli/src/checks/types.ts` interface). Convention for ids: `<plugin-name>:<check-id>` to avoid collisions with built-ins.

Both folders are local-only — no cross-plugin imports. They're build-time tooling, not runtime barrels.

### B. Custom check auto-discovery

In `cli/src/checks/index.ts`:

1. Add `loadPluginChecks(root: string): Promise<Check[]>`. It walks `plugins/**` (reusing the directory walker from `cli/src/docgen.ts:findAllPluginDirs`), looks for `<plugin>/check/index.ts`, dynamic-imports each via `await import(absPath)`, coerces default export to `Check[]`.
2. Modify `runChecks()` to call `loadPluginChecks(root)` once and concat after the built-in `CHECKS` array. Built-ins always run first.
3. Id collisions: warn and skip the plugin one (built-ins win).
4. Keep `CHECKS` (the built-in array) as the synchronous source of truth for Commander flag registration in `cli/src/commands/check.ts:10` — plugin checks don't get their own `--<id>` flag (they always run unless filtered by id string passed to `runChecks(ids)`).

### C. ESLint integration

**Add to root `package.json` devDependencies:** `eslint` (>=9.18 — has built-in TS-config support via jiti), `@typescript-eslint/parser`, `@typescript-eslint/utils` (provides `RuleCreator` for typed rule authoring).

**`eslint.config.ts` (repo root):**

- Sets `@typescript-eslint/parser` for `**/*.{ts,tsx}`.
- Walks `plugins/**` with `readdirSync`, finds `lint/index.ts`, dynamic-imports each, collects the `{ name, rules }` exports.
- Builds a flat config block per plugin: registers it under `plugins[name]` and enables every rule as `"error"` under `<name>/<rule-id>`.
- Must use raw filesystem paths (path aliases like `@plugins/...` are Bun-only and not available to the Node-side ESLint loader).

**`cli/src/checks/eslint.ts`:** new built-in `Check` mirroring `cli/src/checks/typescript.ts`. Spawns `bunx eslint .` from repo root via `Bun.spawn`, captures stdout, returns `{ ok: false, message }` on non-zero exit. Registered in `cli/src/checks/index.ts:CHECKS`.

### D. Plugin-boundaries update

Files under `lint/` and `check/` must not pollute the cross-plugin DAG. In `cli/src/checks/plugin-boundaries.ts`:

- Confirm `runtimeForPath()` returns `null` for path segments `lint` and `check` (today it falls through to `"shared"` for unknown segments — needs an explicit guard).
- Skip DAG-edge collection for files with `null` runtime, instead of defaulting to `"shared"`.
- Do NOT add `lint`/`check` to `VALID_RUNTIMES` or to the R3 barrel-purity loop — these aren't public barrels.

R4/R7/R8 already block any cross-plugin import from anywhere; lint/check files inherit that for free. No new rule needed.

### E. Wire into `build` too

Currently `runChecks()` runs only on `push` (`cli/src/commands/push.ts:130, 186`). Add a call near the end of `cli/src/commands/build.ts` so ESLint and plugin checks run before the gateway is notified. Add a `--skip-checks` flag for fast iteration.

### F. Example (use `welcome` plugin as the canary)

`plugins/welcome/lint/index.ts`:

```ts
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `internal:${name}`);

const noConsoleLog = createRule({
  name: "no-console-log",
  meta: {
    type: "problem",
    docs: { description: "Disallow console.log in plugin source" },
    schema: [],
    messages: { noConsole: "Use a logger instead of console.log." },
  },
  defaultOptions: [],
  create(context) {
    return {
      "CallExpression[callee.object.name='console'][callee.property.name='log']"(node) {
        context.report({ node, messageId: "noConsole" });
      },
    };
  },
});

export default { name: "welcome", rules: { "no-console-log": noConsoleLog } };
```

`plugins/welcome/check/index.ts`:

```ts
import { existsSync } from "fs";
import { join } from "path";
import type { Check } from "../../../cli/src/checks/types";

const hasReadme: Check = {
  id: "welcome:has-readme",
  description: "welcome plugin has a README.md",
  async run() {
    const readme = join(import.meta.dir, "..", "README.md");
    return existsSync(readme)
      ? { ok: true }
      : { ok: false, message: "plugins/welcome/README.md is missing" };
  },
};

export default hasReadme;
```

## Files to modify / add

**Modify:**

- `cli/src/checks/index.ts` — add `loadPluginChecks()`; have `runChecks()` concat plugin-discovered checks.
- `cli/src/checks/plugin-boundaries.ts` — `runtimeForPath()` returns `null` for `lint`/`check` segments; DAG collector skips `null`.
- `cli/src/commands/build.ts` — call `runChecks()` near the end; add `--skip-checks` flag.
- `package.json` (root) — add `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/utils` to `devDependencies`.
- `CLAUDE.md` (and `plugin-core/CLAUDE.md`) — document the `lint/` and `check/` folder convention alongside `web/`, `server/`, `shared/`, `central/`.

**Add:**

- `cli/src/checks/eslint.ts` — new built-in check that spawns `bunx eslint .`.
- `eslint.config.ts` (repo root) — flat config that auto-discovers `plugins/**/lint/index.ts`.
- `plugins/welcome/lint/index.ts` — example rule (no-console-log).
- `plugins/welcome/check/index.ts` — example custom check.

## Verification

1. `./equin build` — bun installs the new ESLint deps; build succeeds.
2. `./equin check` — output includes `• eslint ... ok` and `• welcome:has-readme ... ok`. Each plugin-contributed check appears in the run.
3. `./equin check --list` — built-in checks listed (plugin checks intentionally don't get `--<id>` flags).
4. `./equin check --plugin-boundaries` — still passes (no false-positives from `lint/` or `check/` folders).
5. Add `console.log("test")` to any file under a plugin's `web/` — `./equin check` fails with `welcome/no-console-log`. Remove it; passes again.
6. Make `plugins/welcome/check/index.ts` return `{ ok: false, ... }` — `./equin check` fails with the plugin's check id.

## Open questions / risks

- **ESLint cold start (~2–4s)** is the slowest check. On `push` already required; on `build` mitigated by `--skip-checks`.
- **`@typescript-eslint/utils` major bumps** track `typescript-eslint`'s monorepo. Pin to a specific major to avoid surprise breakage.
- **Plugin `check/index.ts` importing `Check` type** — uses a relative path into `cli/src/checks/types.ts` (avoids a circular workspace dependency). Acceptable since plugins already have implicit knowledge of the repo layout (e.g. `plugin-core/`).
- **ESLint runs under Node, not Bun** (`bunx eslint` shells to Node). Plugin lint rules and `eslint.config.ts` must therefore be Node-compatible — no Bun-only APIs (`Bun.spawn`, `Bun.file`, etc.). Pure logic only. This is a natural fit for lint rules.
