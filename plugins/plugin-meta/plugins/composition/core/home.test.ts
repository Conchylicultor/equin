import { test, expect } from "bun:test";
import { resolveCompositionHome } from "./home";

const apps = new Map([
  ["website", { plugin: "apps.website.shell" }],
  ["debug", { plugin: "apps.debug.shell" }],
]);
const site = new Set(["apps.website", "apps.website.shell", "apps-core"]);
const siteAndDebug = new Set([...site, "apps.debug.shell"]);
const noApps = new Set(["database"]);

test("a home in the bundle resolves to that app, whatever else is bundled", () => {
  expect(
    resolveCompositionHome({
      apps,
      bundle: siteAndDebug,
      home: "website",
      deployed: true,
    }),
  ).toEqual({
    kind: "app",
    appId: "website",
  });
});

test("no home and no app is a legitimate none", () => {
  expect(
    resolveCompositionHome({ apps, bundle: noApps, home: "", deployed: true }),
  ).toEqual({ kind: "none" });
});

test("a lens that is never deployed may leave home empty though it reaches an app", () => {
  expect(
    resolveCompositionHome({ apps, bundle: site, home: "", deployed: false }),
  ).toEqual({ kind: "none" });
  // …but a home it does declare is still checked.
  const r = resolveCompositionHome({
    apps,
    bundle: site,
    home: "debug",
    deployed: false,
  });
  expect(r.kind === "error" && r.reason).toBe("not-in-bundle");
});

test.each([
  ["missing", site, ""],
  ["not-an-app", site, "nope"],
  ["not-in-bundle", site, "debug"],
  ["home-without-apps", noApps, "website"],
] as const)("%s is an error", (reason, bundle, home) => {
  const r = resolveCompositionHome({ apps, bundle, home, deployed: true });
  expect(r.kind === "error" && r.reason).toBe(reason);
});
