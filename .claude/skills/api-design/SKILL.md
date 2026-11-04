---
name: api-design
description: >
  Architecture, abstraction design, and module-boundary rules.
  Read BEFORE designing any new feature.
---

# API and Abstraction Design

## Start by writing the end-user experience

Write the exact command, config line, or function call the user will type. If
you can't state the user experience in one concrete example, you don't yet
understand the feature.

Do this BEFORE starting to think about internal logic, or technical details. The
end user experience do not have to be realistic. It's the aspiration which will
guide the design.

## Code should match high-level semantics

-   Each line of business logic should map to one clear, high-level action (e.g.
    `launch_evaluations()`, `wait_for_results()`, `write_result_to_db(result)`).
-   If a block of code requires a comment to explain what it does (not why),
    extract it into a named function or method that makes the intent
    self-evident.
-   Never mix levels of abstraction in the same function: a function that calls
    `launch_evaluations()` should not also contain low-level socket or
    serialization code.
-   **Pass dependencies, don't reach for globals.** A function should receive
    its inputs as parameters — not access module-level state (flags, singletons)
    internally. Access global state at the top-level entry point and propagate.
-   **Question the function's existence.** When a function mixes unrelated
    concerns, the fix may be to inline it and let the caller compose the pieces
    — not to clean up its internals.
-   **One name per concept.** The same concept must use the same name everywhere
    — across functions, files, and modules. If a value is called `origin` in one
    place and `provenance` in another, pick one.

## Failure must be a type, not an absorbable value

When a function can fail, the failure must be **impossible to mistake for
data**: either **throw**, or return a **discriminated result**
(`{ ok: true, … } | { ok: false, … }` / `{ kind: … }`). Never signal failure
with `null`, `[]`, `""`, `0`, or `false` when the same value can also mean a
legitimate empty/absent success — consumers will absorb it (`?? []`,
`if (x)`) and downstream layers will cache/publish the false-empty as settled
truth (this produced the pane-route, plugin-chunk, and runGit incidents; see
`research/2026-07-08-global-absorbable-failure-guardrail.md`).

Decision rule — **throw by default**; return a discriminated result only when
the union is the real semantics:

-   **Probe** ("does this ref/file/key exist?") — the caller genuinely
    branches on absence: return a result (e.g. `tryRunGit` → `GitResult`).
-   **Batch partial failure** ("3 pruned, 2 failed") — throwing loses the
    partial outcome: return `{ done, failures[] }`.
-   **Maps to an HTTP status** — return the union the handler translates
    (e.g. `FileDiffResult`).

Corollaries: a caches/memo key must never be built from a failed read (abort
the recompute and keep the old entry — stale-safe beats false-fresh); a
watcher/store must keep last-known-good on a failed refresh, never overwrite
with a manufactured empty; "never computed yet" is not the same state as
"computed: empty". The `no-absorbed-failure` lint rule enforces the
catch-block half of this; the producer signature is on you at design time.

**Live-state resources** are the same rule with a specific shape. A loader
branch that *cannot determine* its value returns `unresolved(reason)` —
`Resolvable<T>` from `network/live/live-state/core` — never the empty value; it
throws only for *transient* failures. The transient half is closed for you:
`useLive`'s settled arm has no `error` field, so `data` is unreachable
whenever a load has failed. See the "`pending` means no trustworthy value"
section of `plugins/network/plugins/live/plugins/live-state/CLAUDE.md`.

**A derived ledger's emptiness is never evidence.** A table filled in by a
background job (the `pushes` ledger, fed by `tasks.push-ingest` off
`git.refAdvanced`) reads empty for two unrelated reasons: nothing happened, or
the job has not run yet. No wrapper fixes that — the *source* cannot tell the
two apart, so a decision must not read it. Measure the fact where it is
authoritative (git, the filesystem, the process table) and keep the ledger as
what it is: a row **proves** its event happened, its absence proves nothing, so
it may only be ORed *into* a positive answer. This produced the Drop & Close
incident, where a merged conversation was offered the destructive default; see
`research/2026-08-17-global-attempt-work-git-derived-standing.md`.

## Layered architecture

Organize code in clear dependency layers. Lower layers are general-purpose
utilities; upper layers compose them into domain-specific abstractions.

```
Public API (__init__.py re-exports)
  └── Domain objects (e.g. dataclass-based value types)
        └── Operations / algorithms (standalone functions operating on domain objects)
              └── Utilities (pure helpers: math, numpy wrappers, string manipulation)
```

Each layer only depends on the layer below it.

## Class abstractions

-   Prefer **frozen dataclasses** as the primary data abstraction. Never mutate
    — always produce new instances with `self.replace(field=new_value)`.
-   Use `__post_init__` to normalize/validate inputs. This is the only place
    where mutation is allowed with `object.__setattr__(self, ...)`.
-   Prefer `@functools.cached_property` to methods. Complex logic can often be
    written as cached_property calling other cached_property.
-   When construction requires non-trivial logic or there are multiple ways to
    create an object, provide named `@classmethod` factories (`from_X`,
    `from_Y`) instead of overloading `__init__`.
-   Define extensibility points as **protocols** (expected method names).

## Code organization

### One feature per file

-   Complex new features should go in a **separate new file**, not be appended
    to an existing utility module. Keep files focused on a single
    responsibility.
-   Self-contained subsystems (parsers, grammars, formatters, serializers) must
    be planned as **separate modules from the start**, not as inline code in the
    calling module.

### `__init__.py` and public API

-   The top-level `__init__.py` defines the **public API surface** through
    explicit re-exports.
-   Group exports by category with short comments.

### Module boundaries

-   **Logic belongs with the data it operates on.** When adding a new function,
    place it in the module that owns the data structure it reads or mutates —
    not in the caller that happens to need it first.
