import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { maskSource } from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  findCalls,
  paneDeclarationsIn,
  parsePropsBlock,
  parseServerCompanionKinds,
  parseServerCompanions,
  routeDeclarationsIn,
} from "./static-parse";

// findCalls locates calls over a fully-masked buffer and slices callee/argsBody
// from the original at the aligned offsets — exactly as the facet caller does
// (`maskSource(stripped)` + the block slice). maskSource preserves length, so a
// snippet and its mask index 1:1.
const calls = (block: string) => findCalls(maskSource(block), block);

describe("findCalls", () => {
  test("captures a bare-identifier-arg contribution call", () => {
    expect(calls("DataViewSlots.Filter(textOperatorSet)")).toEqual([
      { callee: "DataViewSlots.Filter", argsBody: "" },
    ]);
  });

  test("still captures and parses an inline object-literal argument", () => {
    const found = calls(
      `DataViewSlots.Cell({ match: "bool", component: BoolCell })`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.callee).toBe("DataViewSlots.Cell");
    const props = parsePropsBlock(found[0]!.argsBody);
    expect(props.match).toContain("bool");
  });

  test("does not emit a phantom slot for a dotted call nested inside an argument", () => {
    const found = calls(`DataViewSlots.Cell({ component: wrap(Foo.bar(x)) })`);
    expect(found.map((c) => c.callee)).toEqual(["DataViewSlots.Cell"]);
  });

  test("does not false-match a dotted call inside a preserved string", () => {
    const found = calls(
      `DataViewSlots.Filter(set /* */) , X.y({ label: "a.b(c" })`,
    );
    expect(found.map((c) => c.callee)).toEqual(["DataViewSlots.Filter", "X.y"]);
  });
});

// ── Pane / route identity ──────────────────────────────────────────
//
// A pane's identity is always a `route:`, spelled two ways. A hoisted route puts
// an IDENTIFIER there, and the id on the `defineRoute()` that identifier names —
// which routinely lives in another plugin's `core/`, so all this half can do is
// record WHICH name in WHICH module; `relate()` completes the join with the tree
// in scope. An inline route puts the whole `defineRoute({ id })` there, and the
// id is read straight off it — nothing to join.
//
// A `Pane.define` spelling neither is a pane the scanner cannot name, and a
// nameless pane is what silently empties the Studio table, the plugin-detail
// card and the PR diff — so it throws rather than being dropped.

describe("routeDeclarationsIn", () => {
  test("reads the binding name and the route id", () => {
    expect(
      routeDeclarationsIn(`
        export const buildRoute = defineRoute({ id: "build", segment: "build" });
        const detail = defineRoute({
          id: "build-detail",
          segment: "r/:runId",
          parent: buildRoute,
        });
      `),
    ).toEqual([
      { name: "buildRoute", routeId: "build" },
      { name: "detail", routeId: "build-detail" },
    ]);
  });

  test("a defineRoute written inside a string or a comment is not a route", () => {
    expect(
      routeDeclarationsIn(`
        // const ghostRoute = defineRoute({ id: "ghost", segment: "g" });
        const snippet = \`const alsoGhost = defineRoute({ id: "also-ghost" })\`;
        const realRoute = defineRoute({ id: "real", segment: "r" });
      `),
    ).toEqual([{ name: "realRoute", routeId: "real" }]);
  });

  test("a dynamically-built id is no id, not a phantom one", () => {
    expect(
      routeDeclarationsIn(
        'const r = defineRoute({ id: prefix + "-detail", segment: "s" });',
      ),
    ).toEqual([]);
  });
});

describe("paneDeclarationsIn", () => {
  test("inline form: the id read straight off the route written in place", () => {
    expect(
      paneDeclarationsIn(`
      export const logsPane = Pane.define({
        route: defineRoute({ id: "logs", segment: "logs" }),
        app: debugApp,
        component: LogsBody,
      });
    `),
    ).toEqual([{ name: "logsPane", id: "logs" }]);
  });

  // The `route:` reader used to return the LEADING IDENTIFIER of whatever stood
  // there, so an inline call came back as the name `defineRoute` — a reference to
  // a route no plugin declares, which `relate()` drops. The pane then lost its id
  // with nothing anywhere saying so.
  test("an inline route is never recorded as a reference to `defineRoute`", () => {
    const [pane] = paneDeclarationsIn(
      'const p = Pane.define({ route: defineRoute({ id: "real" }), app: a });',
    );
    expect(pane?.route).toBeUndefined();
    expect(pane?.id).toBe("real");
  });

  // `defineRoute` is generic, so an explicit type argument is legal — and a
  // local "is the next char a `(`" test would miss it and hand back the callee
  // name. What counts as a call is `markerCallSpans`' answer, which walks the
  // generic block as a balanced whole.
  test("an inline route with an explicit type argument reads the same", () => {
    expect(
      paneDeclarationsIn(
        'const p = Pane.define({ route: defineRoute<{ a: () => void }>({ id: "g" }) });',
      ),
    ).toEqual([{ name: "p", id: "g" }]);
  });

  test("route form: the route's name and the module it came from", () => {
    expect(
      paneDeclarationsIn(`
      import { buildRoute } from "@plugins/build/core";
      export const buildPane = Pane.define({ route: buildRoute, app: buildApp });
    `),
    ).toEqual([
      {
        name: "buildPane",
        route: { name: "buildRoute", module: "@plugins/build/core" },
      },
    ]);
  });

  test("a route declared in the same file carries no module", () => {
    expect(
      paneDeclarationsIn(`
      const localRoute = defineRoute({ id: "local", segment: "l" });
      export const localPane = Pane.define({ route: localRoute, app: someApp });
    `)[0],
    ).toEqual({ name: "localPane", route: { name: "localRoute" } });
  });

  test("an import alias resolves to the name the route is EXPORTED under", () => {
    expect(
      paneDeclarationsIn(`
      import { reportsRootRoute as rootRoute } from "@plugins/reports/core";
      export const reportsPane = Pane.define({ route: rootRoute, app: debugApp });
    `)[0]?.route,
    ).toEqual({
      name: "reportsRootRoute",
      module: "@plugins/reports/core",
    });
  });

  // The reader must scope the `route:` read to the TOP level of the call body. A
  // pane body nests objects spelling the very same key, and with a
  // first-match-at-any-depth read the `route` inside `options` becomes the pane's
  // route — silently, and with no check anywhere to notice.
  test("a nested route never shadows the call's own", () => {
    expect(
      paneDeclarationsIn(`
      import { realRoute } from "./routes";
      export const p = Pane.define({
        title: { useText: (params) => params.id, fallback: "Item" },
        options: { route: decoyRoute, id: "nested-id" },
        route: realRoute,
        app: someApp,
      });
    `),
    ).toEqual([
      { name: "p", route: { name: "realRoute", module: "./routes" } },
    ]);
  });

  // Same rule for the inline arm, which matches a `defineRoute` call by OFFSET:
  // the decoy nested in `options` is a real `defineRoute` call in the same body,
  // so only the offset match keeps it from being taken as the pane's identity.
  test("a nested inline route never shadows the call's own", () => {
    expect(
      paneDeclarationsIn(`
      export const p = Pane.define({
        options: { route: defineRoute({ id: "decoy" }) },
        route: defineRoute({ id: "real" }),
        app: someApp,
      });
    `),
    ).toEqual([{ name: "p", id: "real" }]);
  });

  test("a call spelling no readable identity throws rather than vanishing", () => {
    expect(() =>
      paneDeclarationsIn("const p = Pane.define({ app: someApp });"),
    ).toThrow(/no readable pane id/);
  });

  test("a route the scanner cannot read statically throws too", () => {
    expect(() =>
      paneDeclarationsIn("const p = Pane.define({ route: makeRoute(x) });"),
    ).toThrow(/no readable pane id/);
  });

  // A default import carries no exported name to resolve a route id through, so
  // the reference is unusable — and an unusable reference is not an identity.
  test("a route reached through a default import throws, naming the field", () => {
    expect(() =>
      paneDeclarationsIn(`
      import someRoute from "@plugins/x/core";
      export const p = Pane.define({ route: someRoute, app: a });
    `),
    ).toThrow(/`route: someRoute` is a DEFAULT import/);
  });

  test("the throw names the declaration and, when given one, the file", () => {
    expect(() =>
      paneDeclarationsIn("const p = Pane.define({ app: a });", "web/panes.tsx"),
    ).toThrow(/`p`.*web\/panes\.tsx:1/);
  });

  // Masked out before `markerCallSpans` ever runs, so there is no span to
  // report on — the throw above must not fire for a call that isn't one.
  test("a Pane.define written inside a template literal is not a pane", () => {
    expect(
      paneDeclarationsIn(
        "const tpl = `const ghostPane = Pane.define({ route: ghostRoute })`;",
      ),
    ).toEqual([]);
  });
});

// ── Server companions ──────────────────────────────────────────────

describe("server companions", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  /** A throwaway plugin dir holding `files` (plugin-relative path → source). */
  const pluginDir = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "server-companions-"));
    roots.push(root);
    for (const [rel, src] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), src);
    }
    return root;
  };

  test("findCalls with `bare` also matches a bare token callee, not a nested one", () => {
    const block = `Trigger({ on: x }), ...served.declare, Kind({ a: f(1), companion: true })`;
    expect(
      findCalls(maskSource(block), block, { bare: true }).map((c) => c.callee),
    ).toEqual(["Trigger", "Kind"]);
  });

  test("an owner's kinds opened to companions are read from its `server/`", () => {
    const dir = pluginDir({
      "server/internal/retention.ts": `export const Retention = defineServerContribution<{ reason: string }>("x-retention", { companions: true });
export const Other = defineServerContribution<{ id: string }>("x-other");`,
    });
    expect(parseServerCompanionKinds(dir)).toEqual([
      { binding: "Retention", kind: "x-retention" },
    ]);
  });

  test("a kind opened to companions in `machine/` throws", () => {
    const dir = pluginDir({
      "machine/internal/k.ts": `export const K = defineServerContribution<P>("k", { companions: true });`,
    });
    expect(() => parseServerCompanionKinds(dir)).toThrow(
      /in `machine\/` — a kind opened to companions is declared in the plugin's portable `server\/`/,
    );
  });

  test("a companion contribution names its token as imported; ordinary ones are skipped", () => {
    const dir = pluginDir({
      "server/index.ts": `import { Retention as R, Trigger } from "@plugins/owner/server";
export default {
  contributions: [
    Trigger({ on: "x" }),
    R({ companion: true, reason: "prunes it" }),
  ],
};`,
    });
    expect(parseServerCompanions(dir)).toEqual([
      { token: { name: "Retention", module: "@plugins/owner/server" } },
    ]);
  });

  test("a companion flag it cannot read, or one in `machine/`, throws", () => {
    expect(() =>
      parseServerCompanions(
        pluginDir({
          "server/index.ts": `import { R } from "@plugins/o/server";
export default { contributions: [R({ companion: flag })] };`,
        }),
      ),
    ).toThrow(/must be the literal `true`/);
    expect(() =>
      parseServerCompanions(
        pluginDir({
          "machine/index.ts": `import { R } from "@plugins/o/server";
export default { contributions: [R({ companion: true })] };`,
        }),
      ),
    ).toThrow(
      /in `machine\/` — a companion is contributed from the plugin's portable `server\/index.ts`/,
    );
  });
});
