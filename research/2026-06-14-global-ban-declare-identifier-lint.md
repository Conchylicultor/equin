# Ban `declare` as a value binding name (lint rule)

## Context

A top-level `const declare = …` followed by a statement that references it as a
value (e.g. `declare.foo = …`) is silently **miscompiled by Bun's TS transform**.
Bun treats a statement beginning with the contextual keyword `declare` as a TS
*ambient declaration* and **erases it from the emitted JS** — no type error, no
runtime error; the property is just `undefined` at runtime.

This already caused a real silent failure: while wiring `Resource.Declare`'s
2-arg opt-in, a `const declare = …` binding made `Resource.Declare.getContributions`
`undefined` at runtime, so the boot-snapshot returned 0 resources with no signal
anywhere. It was only caught by manual inspection. The instance was fixed by
renaming to `declareResource`, but the trap is open repo-wide for any future
binding named `declare`.

The goal is to **eliminate this class of silent miscompile at the source** with a
contributed ESLint rule, instead of leaving it as tribal knowledge.

### Reproduction & investigation (done)

Confirmed empirically in `/tmp`:

```ts
const declare: { foo?: number } = {};
declare.foo = 42;
console.log(declare.foo);   // -> undefined under Bun
```

- **Bun** (`bun build`): emits `var declare = {}` and the `console.log`, but the
  `declare.foo = 42;` assignment is **dropped**. `bun run` prints `undefined`.
- **tsc 6.0.3** (`ts.transpileModule`): **keeps** `declare.foo = 42;`, **no
  diagnostics**. So this is a Bun divergence from the TS compiler, not expected
  TS behavior.
- Swept every TS contextual keyword (`namespace`, `module`, `global`, `type`,
  `interface`, `enum`, `abstract`, `async`, `static`, `get`, `set`, `of`, `as`,
  `from`, `infer`) through the same `const X = {…}; X.foo = 42;` pattern:
  **`declare` is the only one that silently drops.** `enum` and `let` fail
  loudly as reserved words; everything else transpiles correctly.
- Searched the repo: **zero** existing value-position identifiers named
  `declare` (the only "declare"-ish names are `declareResource` / `declareToken`
  in `plugins/framework/plugins/server-core/core/resources.ts`, which the rule
  must NOT flag). The rule ships with no false positives and no code migration.

**Follow-up (not in this plan):** report the divergence upstream to Bun. The lint
rule is the defensive guard regardless of upstream fix timeline.

## Approach

Add a new lint sub-plugin `bun-safety` under the lint umbrella, contributing one
rule `no-declare-identifier` that bans `declare` as a **value binding name**
(variables, function/param/class names, imports, catch params, destructuring).

Rationale for bindings-only: if nothing can be *named* `declare`, then no
`declare.foo = …` statement can ever reference a local `declare`. A stray
reference to an undeclared `declare` is already a `tsc` "Cannot find name" error
caught by `type-check`. So banning the binding fully closes the class without
touching property keys / member-expression `.declare` (which are legitimate).

Mirrors the existing `icon-safety` / `reactive-server-io` sub-plugins
byte-for-byte (`ESLintUtils.RuleCreator`, `{ name, rules }` barrel). Contributed
rules are auto-discovered by codegen (`lint.generated.ts`) and enabled as
`error` repo-wide on `**/*.{ts,tsx}` — no manual registration.

The banned set is a `Set` so adding another name later (should a future Bun
version regress another keyword) is a one-line change.

## Files

New sub-plugin, mirroring `plugins/framework/plugins/tooling/plugins/lint/plugins/icon-safety/`:

```
plugins/framework/plugins/tooling/plugins/lint/plugins/bun-safety/
├── CLAUDE.md                       # 1-line description (matches sibling style; build refreshes autogen block)
└── lint/
    ├── index.ts                    # default-export { name: "bun-safety", rules: {...} }
    ├── no-declare-identifier.ts    # the rule
    └── no-declare-identifier.test.ts  # bun:test RuleTester (optional but recommended)
```

### `lint/index.ts`

```ts
import noDeclareIdentifier from "./no-declare-identifier";

export default {
  name: "bun-safety",
  rules: {
    "no-declare-identifier": noDeclareIdentifier,
  },
};
```

### `lint/no-declare-identifier.ts`

```ts
import { ESLintUtils, type TSESLint } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Identifier names Bun's TS transform silently miscompiles in value position.
 * `declare` is a TS contextual keyword: a statement beginning with `declare`
 * (e.g. `declare.foo = …` referencing a `const declare = …`) is parsed by Bun
 * as a TS ambient declaration and ERASED from the emitted JS — no type error,
 * no runtime error, the value is just `undefined`. tsc keeps it. Empirically
 * `declare` is the only contextual keyword with this hazard (`enum`/`let` fail
 * loudly as reserved; all others transpile correctly). Set so future regressions
 * are a one-line add.
 */
const BANNED_BINDING_NAMES = new Set(["declare"]);

export default createRule({
  name: "no-declare-identifier",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `declare` as a value binding name — Bun's TS transform parses " +
        "statements referencing it as ambient declarations and silently erases " +
        "them from the emitted JS.",
    },
    schema: [],
    messages: {
      bannedBinding:
        "`{{name}}` cannot be used as a variable/binding name. Bun's TS transform " +
        "parses a statement beginning with `{{name}}` as a TS ambient declaration " +
        "and silently erases it from the emitted JS — no type or runtime error, the " +
        "value is just `undefined` at runtime (tsc keeps it; this is a Bun divergence). " +
        "Rename this binding.",
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    function walk(scope: TSESLint.Scope.Scope): void {
      for (const variable of scope.variables) {
        if (!BANNED_BINDING_NAMES.has(variable.name)) continue;
        for (const def of variable.defs) {
          context.report({
            node: def.name,
            messageId: "bannedBinding",
            data: { name: variable.name },
          });
        }
      }
      scope.childScopes.forEach(walk);
    }
    return {
      "Program:exit"(node) {
        walk(sourceCode.getScope(node));
      },
    };
  },
});
```

Scope-walk (vs. AST selectors) is deliberate: one `Program:exit` pass over the
scope tree catches every binding kind — `var`/`let`/`const`, function & class
names, params, `import` bindings, catch params, and destructuring — because all
become `scope.variables`. References to an *undeclared* `declare` don't appear as
variables, so bindings-only falls out naturally.

### `lint/no-declare-identifier.test.ts` (optional, recommended)

`bun:test` + `@typescript-eslint/rule-tester` `RuleTester`:
- **invalid:** `const declare = {}`, `let declare = 1`, `function declare(){}`,
  `(declare) => declare`, `import { declare } from "x"`, `const { declare } = o`.
- **valid:** `const declareResource = {}` (substring must not match),
  `obj.declare = 1` (property name), `import { foo as bar } from "x"`,
  `const x = obj.declare`.

## Verification

1. `./equin build` — regenerates `lint.generated.ts` to include the new
   sub-plugin and runs `./equin check` (the `eslint` + `type-check` checks
   pick up the rule automatically; `plugins-doc-in-sync` / `plugins-registry-in-sync`
   stay green from the regen).
2. Negative check — confirm the rule actually fires. Temporarily add
   `const declare = {};` to any `.ts` file and run
   `./equin check eslint` (or `bunx eslint <file>`); expect a
   `bun-safety/no-declare-identifier` error. Remove the temp line.
3. Positive check — confirm no false positives: `./equin check` is clean
   repo-wide (in particular `resources.ts`'s `declareResource` / `declareToken`
   are untouched).
4. If the test file is added: `bun test plugins/framework/plugins/tooling/plugins/lint/plugins/bun-safety/lint/no-declare-identifier.test.ts`.

## Out of scope

- No code migration (zero existing offenders).
- Not banning other contextual keywords — empirically only `declare` is unsafe;
  the `Set` makes future additions trivial if Bun regresses.
- Upstream Bun bug report — separate follow-up.
