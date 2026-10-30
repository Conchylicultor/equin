import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  clearRelationBases,
  defineResource,
  setRelationBases,
  setWatermarkSource,
} from "./resources";
import type { LoadedServerPlugin } from "./types";
import {
  bootPluginGraph,
  runPostReadyPhases,
  runSettledPhase,
} from "./boot-stages";
import { clearHostServices } from "./host-service";

// The boot asserts every declared host service; the services the `bun test`
// preload's desktop providers declared are not this suite's graph.
clearHostServices();

// Where the preload-declare assert sits in the boot sequence: after the
// contributions are collected and BEFORE the ready barrier. The barrier's L2
// sweep deletes every persisted row whose key the Declare set does not list as
// preloaded, so a mis-declared graph must fail before any `onReadyBlocking`
// hook runs. The resource runtime is a process singleton other suites also
// register on, so the expectation names only this suite's own key.
describe("bootPluginGraph — the preload-declare assert", () => {
  test("an undeclared preloaded resource fails boot, naming it, before any onReadyBlocking runs", async () => {
    const key = "server-core-test.boot-stages-undeclared";
    let barrierRan = false;
    // `expect(p).rejects.toThrow()` is typed `void` by bun's matchers, so
    // awaiting it trips `@typescript-eslint/await-thenable`. Capture the
    // rejection instead.
    let caught: unknown;
    try {
      await bootPluginGraph({
        mode: "exec",
        hasCoreBarrel: () => false,
        entries: [
          {
            pluginPath: "test/undeclared",
            id: "test.undeclared",
            dependsOn: [],
            // Registers while loading, as a server barrel does at module eval,
            // and contributes no Resource.Declare.
            loader: async () => {
              defineResource(
                {
                  key,
                  schema: z.number(),
                  preload: "boot",
                  validateParams: () => {},
                },
                { mode: "push", loader: () => 1 },
              );
              return {
                default: {
                  contributions: [],
                  onReadyBlocking: () => {
                    barrierRan = true;
                  },
                },
              };
            },
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(`"${key}"`);
    expect(barrierRan).toBe(false);
  });
});

// The settled phase of a serving host: `runSettledPhase` is the only caller of
// `onSettled`, after the post-ready phases. Plugins are handed in directly — the
// phases read only the loaded definitions.
describe("runSettledPhase — the onSettled hook", () => {
  // The post-ready phases hold a serving host to a change feed and a watermark
  // source when it serves live reads; this graph serves none, but the resource
  // runtime is a process singleton other suites in this bun process register
  // DB-backed reads on, so install inert ones for the duration.
  async function asServingHost<T>(fn: () => Promise<T>): Promise<T> {
    setRelationBases((relation) => [relation]);
    setWatermarkSource(() => Promise.resolve("0"));
    try {
      return await fn();
    } finally {
      setWatermarkSource(null);
      clearRelationBases();
    }
  }

  test("runs after every onAllReady, and never in the post-ready phases", async () => {
    const events: string[] = [];
    const ordered: LoadedServerPlugin[] = [
      {
        id: "test.slow-all-ready",
        onAllReady: async () => {
          await new Promise<void>((r) => setTimeout(r, 5));
          events.push("onAllReady");
        },
      },
      {
        id: "test.settled",
        onSettled: () => {
          events.push("onSettled");
        },
      },
    ];
    await asServingHost(() => runPostReadyPhases(ordered));
    expect(events).toEqual(["onAllReady"]);
    await runSettledPhase(ordered);
    expect(events).toEqual(["onAllReady", "onSettled"]);
  });

  test("a load-bearing plugin's throw rejects the phase; another's is logged", async () => {
    const boom = (): never => {
      throw new Error("settle-boom");
    };
    await runSettledPhase([{ id: "test.optional", onSettled: boom }]);

    let caught: unknown;
    try {
      await runSettledPhase([
        { id: "test.load-bearing", loadBearing: true, onSettled: boom },
      ]);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("settle-boom");
  });
});
