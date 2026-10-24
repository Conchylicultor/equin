import { describe, expect, test } from "bun:test";
import { isDeferredPluginPath, partitionWebEntries } from "./load-tiers";

// These guardrails assert against the REAL committed `web-tiers.generated.ts`
// (via `isDeferredPluginPath`), so they lock in the derivation's headline
// outcomes end-to-end: the structural rule, the watched-slot pins, and the
// dependsOn closure. Regenerating the manifest (via `./equin build`) is
// what keeps them true; the `eager-tier-in-sync` check guards drift.
describe("isDeferredPluginPath (against the generated tier set)", () => {
  test("top-level / non-app-content plugins are eager", () => {
    expect(isDeferredPluginPath("conversations")).toBe(false);
    expect(isDeferredPluginPath("primitives/plugins/pane")).toBe(false);
  });

  test("an app's shell subtree is eager (structural)", () => {
    expect(isDeferredPluginPath("apps/plugins/sonata/plugins/shell")).toBe(
      false,
    );
  });

  test("ordinary app content defers", () => {
    expect(isDeferredPluginPath("apps/plugins/sonata/plugins/notation")).toBe(
      true,
    );
  });

  test("sonata/voicing is pinned eager via the dependsOn closure from the shell", () => {
    expect(isDeferredPluginPath("apps/plugins/sonata/plugins/voicing")).toBe(
      false,
    );
  });

  test("studio content defers now that every app is deferrable", () => {
    expect(isDeferredPluginPath("apps/plugins/studio/plugins/explorer")).toBe(
      true,
    );
  });

  test("mail auto-resume is pinned eager via its Core.Root contribution", () => {
    expect(
      isDeferredPluginPath(
        "apps/plugins/mail/plugins/sync/plugins/auto-resume",
      ),
    ).toBe(false);
  });
});

describe("partitionWebEntries", () => {
  const entries = [
    { pluginPath: "conversations" },
    { pluginPath: "apps/plugins/sonata/plugins/shell" }, // shell → eager
    { pluginPath: "apps/plugins/sonata/plugins/notation" }, // content → deferred
    { pluginPath: "apps/plugins/sonata/plugins/voicing" }, // closure pin → eager
    { pluginPath: "apps/plugins/studio/plugins/explorer" }, // content → deferred
    { pluginPath: "primitives/plugins/pane" },
  ];

  test("covers all entries (eager + deferred === input)", () => {
    const { eager, deferred } = partitionWebEntries(entries);
    expect(eager.length + deferred.length).toBe(entries.length);
  });

  test("preserves input order within each tier", () => {
    const { eager, deferred } = partitionWebEntries(entries);
    expect(eager.map((e) => e.pluginPath)).toEqual([
      "conversations",
      "apps/plugins/sonata/plugins/shell",
      "apps/plugins/sonata/plugins/voicing",
      "primitives/plugins/pane",
    ]);
    expect(deferred.map((e) => e.pluginPath)).toEqual([
      "apps/plugins/sonata/plugins/notation",
      "apps/plugins/studio/plugins/explorer",
    ]);
  });
});
