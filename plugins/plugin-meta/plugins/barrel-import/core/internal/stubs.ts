import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  declareRuntimeNamespace,
  hasRuntimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { withThreadActivity } from "@plugins/infra/plugins/stack-sampler/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { relative, resolve } from "node:path";
import { registerAutoStubs } from "./auto-stubs.generated";

let registered = false;

/**
 * The dummy runtime namespace the stubs declare (see `registerBarrelStubs`).
 *
 * A LIE, but one that now dies with the process: it is declared into this
 * process's module state rather than written into its environment, so nothing
 * this process spawns can inherit it. That is what retired the value-scoped
 * scrub the check-subprocess helper used to carry — a child that inherited the
 * sentinel used to write its transcript and its progress records under a
 * worktree that does not exist.
 *
 * Still exported: it is the one spelling of the sentinel, and a reader finding
 * it in a log should be able to grep to here. It is a valid namespace by
 * construction (`asNamespace` below would throw otherwise).
 */
export const BARREL_STUB_WORKTREE = "barrel-import-stub";

/**
 * Registers Bun runtime stubs so web/server barrel files can be imported
 * outside the browser. Must be called once before any `importBarrel()` call.
 *
 * Uses build.module() for the generated npm-package stubs (see
 * auto-stub-packages.ts) and build.onLoad() for CSS files. Path aliases
 * (@plugins/* → plugins/*, @/* → web/src/*) are resolved via the root
 * tsconfig.json.
 *
 * React is NOT stubbed: `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`,
 * `react-dom` and `react-dom/client` load for real. A static named import is
 * bound at link time, so a hand-kept React export list broke the build every
 * time web code imported a name it lacked (`useInsertionEffect` was the last),
 * with an error blaming whichever barrel happened to reach that module. No
 * consumer reads fake React semantics — they read plain contribution/slot data
 * — and React is a pure JS package whose eval-time surface (createContext,
 * memo, forwardRef, lazy, createElement) needs no DOM. It is evaluated once per
 * process (ESM cache), ~50–75 ms. There must be no hand-written export lists
 * in this file: a package is either real or stubbed from its own `.d.ts`.
 *
 * NOTE: `@plugins/framework/plugins/web-sdk/core` is deliberately NOT stubbed
 * either. The real barrel only pulls in `react`, `plugin-id/core`, and
 * `collected-dir/core` — all side-effect-free — so it loads verbatim, resolved
 * through the tsconfig `@plugins/*` alias like any other barrel. Stubbing it
 * forced a hand-maintained mirror of its export list that silently broke docgen
 * whenever a new export was added; letting the real module be its own source of
 * truth removes that coupling entirely.
 */
export function registerBarrelStubs(_repoRoot: string): void {
  if (registered) return;
  registered = true;

  // Several server modules resolve the process's runtime namespace at module
  // eval (config_v2's config dir), and the database pool needs one on its first
  // query. Declare a dummy so they evaluate; pg.Pool connections are lazy, so no
  // real DB connect happens.
  //
  // The stub is a FALLBACK, not an answer. A process that was already told who
  // it is — a `bun test` through its preload, an exec child through its spawner
  // — keeps that identity, because a placeholder must never contest a real
  // declaration: `declareRuntimeNamespace` throws on a second, DIFFERENT value,
  // so an unconditional stub killed every test that imports a barrel before it
  // reached a single line of the logic under test. Only a process with no answer
  // of its own gets the placeholder.
  //
  // The guard the throw really defends — two different REAL answers, which is a
  // genuine bug — is untouched: nothing below asks for the sentinel a second
  // time, and a real declaration still collides with a real one.
  if (!hasRuntimeNamespace()) {
    declareRuntimeNamespace(asNamespace(BARREL_STUB_WORKTREE));
  }

  const noop = () => {};

  // Read structurally rather than as `globalThis.window`: this module runs in
  // Bun, where there is no window, and the structural probe says exactly that —
  // "does this runtime happen to have one" — instead of asserting a DOM global
  // into server code. (It was once also a hard requirement, from a tsconfig
  // whose `lib` withheld DOM; the repo builds one full-lib program now, so the
  // spelling is intent, not a compiler error.)
  if (typeof (globalThis as { window?: unknown }).window === "undefined") {
    const loc = {
      protocol: "http:",
      host: "localhost",
      hostname: "localhost",
      port: "",
      pathname: "/",
      search: "",
      hash: "",
      href: "http://localhost/",
      origin: "http://localhost",
    };
    const fakeEl = () => ({
      style: {},
      setAttribute: noop,
      addEventListener: noop,
      appendChild: noop,
      classList: {
        add: noop,
        remove: noop,
        toggle: noop,
        contains: () => false,
      },
    });
    // Must NOT gain a `document` property. react-dom-client decides at eval
    // whether it runs in a browser by probing `window.document.createElement`
    // (its `canUseDOM`); without it, it takes the no-DOM path and skips its
    // DOM feature probes and the DevTools console banner. The top-level
    // `document` global below is separate and does not flip that probe.
    (globalThis as any).window = {
      location: loc,
      addEventListener: noop,
      removeEventListener: noop,
      matchMedia: () => ({
        matches: false,
        addEventListener: noop,
        removeEventListener: noop,
        addListener: noop,
        removeListener: noop,
      }),
      getComputedStyle: () => new Proxy({}, { get: () => "" }),
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
      cancelAnimationFrame: noop,
      innerWidth: 1280,
      innerHeight: 800,
      navigator: { userAgent: "stub" },
    };
    (globalThis as any).document = {
      createElement: fakeEl,
      createElementNS: fakeEl,
      createTextNode: () => ({}),
      addEventListener: noop,
      removeEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      documentElement: { style: {}, classList: { add: noop, remove: noop } },
      body: { style: {}, appendChild: noop },
      head: { appendChild: noop },
    };
    (globalThis as any).MutationObserver = class {
      observe = noop;
      disconnect = noop;
      takeRecords = () => [];
    };
    (globalThis as any).ResizeObserver = class {
      observe = noop;
      disconnect = noop;
      unobserve = noop;
    };
    (globalThis as any).IntersectionObserver = class {
      observe = noop;
      disconnect = noop;
      unobserve = noop;
    };
  }

  Bun.plugin({
    name: "barrel-import-stubs",
    setup(build) {
      // React (react, react/jsx-runtime, react/jsx-dev-runtime, react-dom,
      // react-dom/client) is intentionally left unstubbed — see the note on
      // registerBarrelStubs.

      // @plugins/framework/plugins/web-sdk/core is intentionally left unstubbed —
      // the real barrel loads against the real React (see the note on
      // registerBarrelStubs). Stubbing it is what created the export-list drift bug.

      // @plugins/database/server is intentionally left unstubbed too: its barrel
      // is import-safe (lazy pool, no WORKTREE read at eval — see
      // plugins/database/CLAUDE.md § Import-safety), so the real module loads.
      // A hand-written export list here drifted the moment the barrel grew an
      // export another barrel reads at eval (withQueryDeadline broke docgen).

      // ── Auto-generated stubs for npm packages ─────────────────────
      // Reads .d.ts entry points to discover named exports at build time.
      // To add a package: edit auto-stub-packages.ts and run ./equin build.
      registerAutoStubs(build);

      // ── CSS imports → empty ───────────────────────────────────────
      build.onLoad({ filter: /\.css$/ }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  });
}

/**
 * Optional one-shot guard fired immediately before the FIRST barrel import.
 *
 * The codegen pipeline installs this to assert all pre-barrel `*.generated.ts`
 * manifests are fresh before any barrel freezes the ESM cache (a later disk
 * write cannot invalidate a frozen module). Kept here so the freeze point and
 * its guard are co-located; barrel-import owns no codegen knowledge — the guard
 * fn is injected via `setPreBarrelImportGuard`.
 */
let preBarrelImportGuard: (() => void | Promise<void>) | null = null;

/** Install (or replace) the one-shot pre-barrel-import guard. */
export function setPreBarrelImportGuard(fn: () => void | Promise<void>): void {
  preBarrelImportGuard = fn;
}

/**
 * ONE barrel import at a time, process-wide. Not a performance gate — a
 * correctness one, and the reason it lives HERE rather than at any one caller.
 *
 * A plugin barrel's module graph is cyclic in places (barrels import barrels).
 * ESM answers a dynamic `import()` for a module whose evaluation is ALREADY IN
 * FLIGHT with its partially-evaluated namespace, immediately — that is the
 * defined behaviour for a cycle, not a bug. So a second import loop reading
 * `mod.default` off such a namespace hits the binding before its initializer has
 * run: `ReferenceError: Cannot access 'default' before initialization`. The
 * module it named was mid-evaluation inside SOMEONE ELSE's import.
 *
 * That needs two loops overlapping, and this process has them: the check runner
 * awaits every selected check under `Promise.all`
 * (`tooling/plugins/checks/core/runner.ts`), and ~7 call sites run a barrel
 * import loop of their own — the two scoped declaration passes, the docs tree,
 * `token-group-vars`, `config-origin`, `registrations-paired`, the page checks.
 * Any two of them selected together is the hazard; `./equin check
 * reorderable-slots-in-sync facets:render-complete` is one live pair.
 *
 * DO NOT REMOVE AS REDUNDANT. Before the declaration pass was scoped per
 * `(scope, root)`, a single memo per root meant concurrent callers joined ONE
 * in-flight promise, which serialized the imports by accident. Nothing states
 * that now, and nothing ever stated it for the loops outside that memo — those
 * have always been able to overlap, so a caller-level fix would leave the same
 * defect reachable from the next pair of checks anyone selects together.
 *
 * The wait is nearly free: whoever queues second finds every module already in
 * the ESM cache and returns from a resolved promise.
 */
const barrelImportLane = createSemaphore(1);

/** This file's checkout — only to name an import repo-relatively in a sample. */
const CHECKOUT_ROOT = resolve(import.meta.dir, "../../../../../..");

/**
 * Dynamically import a barrel file. Throws on failure so missing stubs
 * surface as build errors rather than silently omitting plugin metadata.
 * Requires `registerBarrelStubs()` to have been called first.
 */
export function importBarrel(
  barrelPath: string,
): Promise<Record<string, unknown>> {
  return barrelImportLane.run(async () => {
    // Inside the lane, so the guard finishes before ANY barrel is imported —
    // including one a concurrent caller asked for while the guard was still
    // awaiting. It cannot deadlock on the lane it holds: every pre-barrel
    // manifest renderer is barrel-free by definition (that IS the membership
    // rule, enforced by `pre-barrel-manifests-complete`).
    //
    // Fire-once: capture and clear FIRST (even if it throws), so a single
    // barrel import triggers it exactly once and never re-arms.
    if (preBarrelImportGuard) {
      const guard = preBarrelImportGuard;
      preBarrelImportGuard = null;
      await guard();
    }
    let mod: Record<string, unknown>;
    try {
      // Marked, because loading and evaluating a module leaves no JS frame on
      // most stack samples — a thread watch sees only `(anonymous) [Unknown
      // Executable]`, and with the mark it can say which barrel was loading.
      mod = await withThreadActivity(
        { name: "barrel import", detail: relative(CHECKOUT_ROOT, barrelPath) },
        async () => (await import(barrelPath)) as Record<string, unknown>,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[barrel-import] Failed to import ${barrelPath}: ${msg}`);
    }
    // A macrotask between barrels, still inside the lane (so import ORDER holds
    // for callers whose stubs depend on it): a loop over ~800 barrels used to
    // evaluate them back to back, holding a shared thread for seconds.
    await yieldMacrotask();
    return mod;
  });
}
