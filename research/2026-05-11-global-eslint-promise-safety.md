# ESLint Promise Safety Rules

## Context

A recurring crash (`AbortError: Lock broken by another request with the 'steal' option`, 18 occurrences) was caused by an unhandled promise rejection in `cross-tab-election.ts`. The root cause: `void this.locks.request(...)` discarded the promise, so when the lock was stolen the rejection went unhandled.

No lint rule caught this. `@typescript-eslint/no-floating-promises` would have flagged it at build time, but wasn't enabled. Worse, when agents fix such violations, the naive fix — `.catch(() => {})` — silently swallows the error, trading a visible crash for an invisible bug.

This plan adds three layers of defense:
1. **`no-floating-promises` with custom instructional messages** — forces agents to handle every promise
2. **`no-bare-catch` custom rule** — blocks the lazy fix (empty catch, console.error as handler)
3. **CLAUDE.md guidance** — teaches the correct patterns before agents even hit the lint error

## Design decisions

**Where do the global rules live?** `cli/src/lint/promise-safety/`, alongside the existing `cli/src/checks/`, `cli/src/guards/`, and `cli/src/boundaries/`. The existing plugin lint system (`plugins/<name>/lint/`) scopes rules to the contributing plugin's subtree — these rules must apply globally. The `cli/src/lint/` directory is a plain TS module directory imported by `eslint.config.ts`. ESLint runs via `bunx eslint`, so the TS imports resolve natively.

**Wrapper rule instead of raw `no-floating-promises`.** ESLint v9 has no mechanism to inject custom messages into third-party rules. The only approach: re-export the original rule with patched `meta.messages`. The `create` function is spread untouched — only the error text changes. The original rule is disabled, the wrapper runs instead.

**`no-misused-promises` tuning.** 85 violations, 74 of which are `onClick={async () => ...}` — a false positive for JSX event handlers. Set `checksVoidReturn: { attributes: false }` to suppress the JSX noise while keeping meaningful checks on function arguments and properties.

**`void` does not silence errors.** `void promise` tells ESLint "I know this is a promise, I'm deliberately not awaiting it." But it does NOT catch the rejection — if the promise rejects, it fires an `unhandledrejection` browser event, which the `crashes` plugin catches and reports. So `void` means "failure will surface through the global error handler" — it's appropriate only when there's no better local handler (background refreshes, best-effort pings). For anything where a specific error message should reach the user (toasts, error boundaries), use `.catch()` with a real handler.

**Existing violations are NOT fixed.** Another agent will handle those. This plan only sets up the rules and guidance.

## Implementation

### 1. Create `cli/src/lint/promise-safety/no-floating-promises.ts`

Wraps `@typescript-eslint/eslint-plugin`'s `no-floating-promises` with custom messages.

```ts
import tsPlugin from "@typescript-eslint/eslint-plugin";

const original = tsPlugin.rules!["no-floating-promises"];

const GUIDANCE =
  "\n\nDo NOT silently swallow errors with .catch(() => {}) or .catch(console.error) — this hides bugs." +
  "\n\nFix: (1) `await` the promise, (2) `.catch()` with a specific handler that re-throws unknown errors, or (3) prefix with `void` for intentional fire-and-forget (errors still surface via the global unhandledrejection handler). See CLAUDE.md § Promise handling.";

export default {
  ...original,
  meta: {
    ...original.meta,
    messages: Object.fromEntries(
      Object.entries(original.meta.messages).map(([id, msg]) =>
        // Append guidance to error messages, but not to autofix suggestion labels
        [id, id.startsWith("floatingFix") ? msg : msg + GUIDANCE],
      ),
    ),
  },
};
```

The 8 messageIds to preserve: `floating`, `floatingVoid`, `floatingFixAwait`, `floatingFixVoid`, `floatingPromiseArray`, `floatingPromiseArrayVoid`, `floatingUselessRejectionHandler`, `floatingUselessRejectionHandlerVoid`. The `floatingFix*` entries are autofix suggestion labels — keep those short.

### 2. Create `cli/src/lint/promise-safety/no-bare-catch.ts`

Custom rule banning semantically empty `.catch()` handlers.

Patterns flagged:
- `.catch(() => {})` — empty arrow/function body
- `.catch((_e) => {})` — underscore param, empty body (same check — body length 0)
- `.catch(console.error)` / `.catch(console.warn)` — logs but swallows

```ts
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

export default createRule({
  name: "no-bare-catch",
  meta: {
    type: "problem",
    docs: { description: "Disallow .catch() handlers that silently swallow rejections." },
    schema: [],
    messages: {
      empty:
        "Empty .catch() silently swallows errors — this hides bugs. " +
        "Handle the specific exception and re-throw unknown errors, " +
        "or remove the .catch() and use `void promise` if fire-and-forget is intentional " +
        "(errors still surface via the global unhandledrejection handler). " +
        "See CLAUDE.md § Promise handling.",
      consoleOnly:
        ".catch(console.error/warn) logs the error but swallows the rejection — " +
        "the caller sees success and the bug becomes invisible. " +
        "Throw after logging, or propagate the rejection. " +
        "See CLAUDE.md § Promise handling.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "CallExpression[callee.property.name='catch']"(node) {
        const arg = node.arguments[0];
        if (!arg) return;

        // .catch(() => {}) or .catch(function() {})
        if (
          (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression") &&
          arg.body.type === "BlockStatement" &&
          arg.body.body.length === 0
        ) {
          context.report({ node, messageId: "empty" });
          return;
        }

        // .catch(console.error) or .catch(console.warn)
        if (
          arg.type === "MemberExpression" &&
          arg.object.type === "Identifier" &&
          arg.object.name === "console" &&
          arg.property.type === "Identifier" &&
          (arg.property.name === "error" || arg.property.name === "warn")
        ) {
          context.report({ node, messageId: "consoleOnly" });
        }
      },
    };
  },
});
```

### 3. Create `cli/src/lint/promise-safety/index.ts`

Barrel exporting both rules.

```ts
import noBareCatch from "./no-bare-catch";
import noFloatingPromises from "./no-floating-promises";

export const promiseSafetyRules = {
  "no-bare-catch": noBareCatch,
  "no-floating-promises": noFloatingPromises,
};
```

### 4. Update `eslint.config.ts`

**Add import:**
```ts
import { promiseSafetyRules } from "./cli/src/lint/promise-safety/index";
```

**Update the `baseConfigs` entry** that has `files: ["**/*.{ts,tsx}"]`:

```ts
{
  files: ["**/*.{ts,tsx}"],
  languageOptions: {
    parser: tsParser as unknown as Linter.Parser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      projectService: true,
      tsconfigRootDir: here,
    },
  },
  plugins: {
    "@typescript-eslint": tsPlugin as unknown as Linter.Plugin,
    "promise-safety": { rules: promiseSafetyRules } as unknown as Linter.Plugin,
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "off",  // replaced by wrapper with better messages
    "@typescript-eslint/no-misused-promises": ["error", {
      checksVoidReturn: { attributes: false },
    }],
    "promise-safety/no-floating-promises": "error",
    "promise-safety/no-bare-catch": "error",
  },
},
```

### 5. Update root `CLAUDE.md` — add to Instructions section

Add after the "On breakage, rebase to HEAD first" bullet (line 201), before the "When the user explicitly says Exit" bullet:

```markdown
- **Promise handling — never swallow rejections.** Two global ESLint rules enforce this (`cli/src/lint/promise-safety/`):
  - `promise-safety/no-floating-promises` — every promise must be explicitly handled.
  - `promise-safety/no-bare-catch` — `.catch(() => {})` and `.catch(console.error)` are banned because they silently swallow errors and hide bugs.

  Correct patterns (in order of preference):
  - `await promise` — preferred when in an async context.
  - `promise.catch((err) => { if (err instanceof Expected) handle(err); else throw err; })` — catch specific exceptions, re-throw unknown. Use when a specific error message should reach the user (toast, error boundary).
  - `void promise` — intentional fire-and-forget. The rejection is NOT caught — it still surfaces via the global `unhandledrejection` handler (which the `crashes` plugin reports). Use only when there is no better local handler (background refreshes, best-effort pings).

  Never: bare `promise;` (floating), `.catch(() => {})` (swallowed), `.catch(console.error)` (logged but lost). These hide bugs.
```

## Files to create/modify

| File | Action |
|---|---|
| `cli/src/lint/promise-safety/no-floating-promises.ts` | Create — wrapper rule |
| `cli/src/lint/promise-safety/no-bare-catch.ts` | Create — custom rule |
| `cli/src/lint/promise-safety/index.ts` | Create — barrel |
| `eslint.config.ts` | Modify — import + rule swap + misused-promises tuning |
| `CLAUDE.md` | Modify — add promise handling guidance to Instructions |

## Verification

1. `bunx eslint . 2>&1 | grep 'promise-safety/no-floating-promises'` — should show the 14 violations with custom instructional messages
2. `bunx eslint . 2>&1 | grep 'promise-safety/no-bare-catch'` — should catch any existing bare `.catch(() => {})` patterns
3. `bunx eslint . 2>&1 | grep 'no-misused-promises'` — should show fewer violations (the 74 JSX attribute false positives gone, ~11 remaining)
4. `./equin check --eslint` — should run without crashing (violations are expected, but the check runner shouldn't error)
5. Write a quick test file with the bad patterns and verify each fires the right rule with the custom message:
   ```ts
   // test: should fire promise-safety/no-floating-promises
   fetch("/api");
   // test: should fire promise-safety/no-bare-catch (empty)
   fetch("/api").catch(() => {});
   // test: should fire promise-safety/no-bare-catch (consoleOnly)
   fetch("/api").catch(console.error);
   // test: should NOT fire (correct pattern)
   void fetch("/api");
   await fetch("/api");
   fetch("/api").catch((e) => { throw e; });
   ```
