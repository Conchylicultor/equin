import { expect, test } from "bun:test";
import { openPane, Pane, type } from "./pane";
import type { ResolveResult } from "./resolve";
import { defineApp, defineRoute } from "../core";

// ---------------------------------------------------------------------------
// Compile-time regression guard for the pane "write path" typing.
//
// `openPane` (and `useToggle`) check the `params` argument against the target
// pane's full param set:
//   - a PARAMFUL pane requires exactly its declared params (no missing, no
//     extra keys),
//   - a PARAMLESS pane accepts only `{}` (stray keys rejected — validates the
//     closed empty param set, `Record<string, never>`).
//
// The same closed-set discipline covers the two NON-URL surfaces:
//   - `options` — the opener may pass a Partial of the pane's declared defaults
//     and nothing else; `useOptions()` returns them TOTAL (never `Partial`),
//     because the deep-link value is the declared default.
//   - `hint` — an ephemeral optimistic mirror; `useHint()` yields a `Hint<T>`
//     whose only accessor demands the canonical value beside it.
// A pane declaring neither rejects both outright (the hole that let a dead
// `input: { convId }` ride on `attemptPane`).
//
// The assertions below are validated by `./equin check type-check`: every
// `@ts-expect-error` must correspond to a real error (tsc fails on an UNUSED
// directive), and every positive case must compile. The function is NEVER
// invoked at runtime, so the live store is never touched.
// ---------------------------------------------------------------------------

const Dummy = () => null;

// Local fixture app — this harness is about the write-path typing, not homes.
const testApp = defineApp({
  id: "wtp-app",
  name: "Write path test app",
  basePath: "/wtp-app",
  iconKey: "science",
});

const paramfulRoute = defineRoute({ id: "wtp-paramful", segment: "wtp/:foo" });

const paramful = Pane.define({
  route: paramfulRoute,
  app: testApp,
  useResolve: false,
  component: Dummy,
});

const emptyParamsRoute = defineRoute({
  id: "wtp-paramless",
  segment: "wtp-none",
});

// Doubles as the "declares neither options nor hint" fixture, which is why the
// options/hint blocks below reject against it.
const paramless = Pane.define({
  route: emptyParamsRoute,
  app: testApp,
  component: Dummy,
});

const optionedRoute = defineRoute({ id: "wtp-optioned", segment: "wtp-opt" });

const optioned = Pane.define({
  route: optionedRoute,
  app: testApp,
  component: Dummy,
  options: { focused: false },
});

const hintedRoute = defineRoute({ id: "wtp-hinted", segment: "wtp-hint" });

const hinted = Pane.define({
  route: hintedRoute,
  app: testApp,
  component: Dummy,
  hint: type<{ title: string }>(),
});

// ---------------------------------------------------------------------------
// The closed empty param set. A route's own empty case is a bare `{}` (routes
// CHAIN their params, and an index signature intersected into a child's real
// params would collapse every property to `never`), so the close back to the
// key-rejecting `Record<string, never>` happens at the `PaneObject`
// boundary — `Closed<>`. A paramless fixture is what proves it happened.
// ---------------------------------------------------------------------------

const paramlessRoute = defineRoute({
  id: "wtp-route-paramless",
  segment: "wtp-route-none",
});

const routeParamless = Pane.define({
  route: paramlessRoute,
  app: testApp,
  component: Dummy,
});

// A two-level chain, where a route's two param sets genuinely differ: the
// parent owns `:pid`, the child owns `:cid`. An opener needs both (that is
// what the URL is built from); the child pane itself only ever sees `:cid`.
const parentRoute = defineRoute({
  id: "wtp-route-parent",
  segment: "wtp-p/:pid",
});
const childRoute = defineRoute({
  id: "wtp-route-child",
  segment: "wtp-c/:cid",
  parent: parentRoute,
});

const routeChild = Pane.define({
  route: childRoute,
  app: testApp,
  // OWN params — the resolve guard is handed `entry.params`, which
  // `extractOwnParams` filtered to this pane's own segment names.
  useResolve: ({ cid }: { cid: string }): ResolveResult => ({
    status: cid !== "" ? "found" : "missing",
  }),
  component: Dummy,
});

// Never called — purely a type-level harness so `liveStore` is never reached.
function typeAssertions() {
  // Paramful: missing required `foo`.
  // @ts-expect-error - `foo` is required
  openPane(paramful, {}, { mode: "root" });

  // Paramful: extra key `bar` rejected.
  // @ts-expect-error - `bar` is not a declared param
  openPane(paramful, { foo: "x", bar: "y" }, { mode: "root" });

  // Paramful: correct — compiles.
  openPane(paramful, { foo: "x" }, { mode: "root" });

  // Paramless: extra key rejected (validates the closed empty param type).
  // @ts-expect-error - paramless pane accepts no params
  openPane(paramless, { foo: "x" }, { mode: "root" });

  // Paramless: empty — compiles.
  openPane(paramless, {}, { mode: "root" });

  // ---- useToggle: pure type-level assertions (the hook is never called) ----
  // `useToggle(params, opts?)` checks `params` against the pane's full params,
  // identically to `openPane`. Assert assignability of the first arg type via
  // typeof rather than invoking the hook outside a render.
  type ParamfulToggleParams = Parameters<typeof paramful.useToggle>[0];
  type ParamlessToggleParams = Parameters<typeof paramless.useToggle>[0];

  const okParamful: ParamfulToggleParams = { foo: "x" };
  void okParamful;
  // @ts-expect-error - `foo` is required for the paramful pane's toggle
  const missingParamful: ParamfulToggleParams = {};
  void missingParamful;
  // @ts-expect-error - `bar` is not a declared param
  const extraParamful: ParamfulToggleParams = { foo: "x", bar: "y" };
  void extraParamful;

  const okParamless: ParamlessToggleParams = {};
  void okParamless;
  // @ts-expect-error - paramless toggle accepts no params
  const extraParamless: ParamlessToggleParams = { foo: "x" };
  void extraParamless;

  // ---- options: a Partial of the declared defaults, and nothing else --------
  openPane(optioned, {}, { mode: "root", options: { focused: true } });
  openPane(optioned, {}, { mode: "root", options: {} });
  // @ts-expect-error - `focused` is a boolean, not a string
  openPane(optioned, {}, { mode: "root", options: { focused: "yes" } });
  // @ts-expect-error - `bogus` is not a declared option
  openPane(optioned, {}, { mode: "root", options: { bogus: 1 } });
  // @ts-expect-error - a pane declaring no options accepts none
  openPane(paramless, {}, { mode: "root", options: { focused: true } });

  // `useOptions()` is TOTAL: a declared key is never `| undefined`, so a read
  // site has no absence to launder into a fabricated default with `??`.
  const opts: { focused: boolean } = {} as ReturnType<
    typeof optioned.useOptions
  >;
  void opts;

  // ---- hint: the declared shape, and nothing else ---------------------------
  openPane(hinted, {}, { mode: "root", hint: { title: "Hello" } });
  // @ts-expect-error - `title` is required by the declared hint shape
  openPane(hinted, {}, { mode: "root", hint: {} });
  // @ts-expect-error - `subtitle` is not part of the declared hint shape
  openPane(hinted, {}, { mode: "root", hint: { title: "a", subtitle: "b" } });
  // @ts-expect-error - a pane declaring no hint accepts none
  openPane(paramless, {}, { mode: "root", hint: { title: "Hello" } });

  // `Hint` carries no data: the ONLY accessor is `pick`, and it requires the
  // canonical value beside it. There is no way to read `title` on its own.
  type HintApi = ReturnType<typeof hinted.useHint>;
  const hintApi = {} as HintApi;
  const picked: string | undefined = hintApi.pick("title", "canonical");
  void picked;
  // @ts-expect-error - `pick` requires the canonical value as its 2nd argument
  hintApi.pick("title");
  // @ts-expect-error - `subtitle` is not a hinted key
  hintApi.pick("subtitle", "x");
  // @ts-expect-error - the canonical value must match the hinted key's type
  hintApi.pick("title", 42);
  // @ts-expect-error - a hint exposes no data properties, only `pick`
  hintApi.title;

  // ---- `useInput()` is gone. Options and hints are not interchangeable. -----
  // @ts-expect-error - `useInput` no longer exists on a PaneObject
  hinted.useInput();

  // ---- route form: the empty param set is closed too ------------------------
  // @ts-expect-error - a paramless ROUTE pane accepts no params either
  openPane(routeParamless, { foo: "x" }, { mode: "root" });
  openPane(routeParamless, {}, { mode: "root" });

  type RouteParamlessToggleParams = Parameters<
    typeof routeParamless.useToggle
  >[0];
  const okRouteParamless: RouteParamlessToggleParams = {};
  void okRouteParamless;
  // @ts-expect-error - a paramless route pane's toggle accepts no params
  const extraRouteParamless: RouteParamlessToggleParams = { foo: "x" };
  void extraRouteParamless;

  // ---- route form: CHAINED params in, OWN params out -----------------------
  // The opener supplies the whole chain, because that is what the URL needs.
  openPane(routeChild, { pid: "p", cid: "c" }, { mode: "root" });
  // @ts-expect-error - the ancestor's `pid` is required, never silently blank
  openPane(routeChild, { cid: "c" }, { mode: "root" });
  // @ts-expect-error - `zz` is not a param anywhere in the chain
  openPane(routeChild, { pid: "p", cid: "c", zz: "1" }, { mode: "root" });

  // `.link()` is non-optional on a route pane, and takes the same chained set.
  const chainedUrl: string = routeChild.link(testApp, { pid: "p", cid: "c" });
  void chainedUrl;

  // `useParams()` is OWN-only: at runtime it returns `entry.params`, which
  // holds this pane's own segment names and nothing else. Typing the ancestor's
  // `pid` in here would offer a key that is always `undefined`.
  type RouteChildOwnParams = ReturnType<typeof routeChild.useParams>;
  const ownOnly: RouteChildOwnParams = { cid: "c" };
  void ownOnly;
  // @ts-expect-error - `pid` is the ancestor's; this pane is never handed it
  const ownWithAncestor: RouteChildOwnParams = { cid: "c", pid: "p" };
  void ownWithAncestor;
}

test("pane write-path param typing guard compiles", () => {
  expect(typeof typeAssertions).toBe("function");
});
