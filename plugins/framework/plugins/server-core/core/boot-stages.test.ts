import { afterAll, describe, expect, test } from "bun:test";
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
  runReadyBarrier,
  runSettledPhase,
  runShutdownHooks,
} from "./boot-stages";
import { sinkHandler } from "./sink-handler";
import { isolateHostServices } from "./testing/host-services";
import { clearCollectedContributions } from "./contributions";

// The boot asserts every declared host service; the services the `bun test`
// preload's desktop providers declared are not this suite's graph. They come
// back after, for the suites that run later in the same bun process.
isolateHostServices();
// This suite boots graphs in the shared bun process: forget them after, so the
// next suite is back to "no graph booted" (its host services the preload's).
afterAll(() => clearCollectedContributions());

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
    const boot = bootPluginGraph({
      mode: "exec",
      entries: [
        {
          pluginPath: "test/undeclared",
          id: "test.undeclared",
          dependsOn: [],
          core: null,
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
    expect(boot).rejects.toThrow(`"${key}"`);
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

// A sink handler attaches in the ready barrier — the phase every boot mode
// runs; an `exec` boot (the supervised job child) runs no `onReady`, and a
// handler registered there never drained the child's sink. It attaches after
// its `dependsOn` parents' blocking hooks, before its plugin's own, and
// detaches only after every `onShutdown`. Plugins are handed in directly.
describe("sinkHandlers — attached in the ready barrier", () => {
  test("attaches after the parents' onReadyBlocking and before its own; detaches after every onShutdown", async () => {
    const log: string[] = [];
    const sink = {
      register(fn: ((body: string) => void) | null) {
        log.push(fn ? "attach" : "detach");
      },
    };
    const parent: LoadedServerPlugin = {
      id: "test.parent",
      onReadyBlocking: () => {
        log.push("parent onReadyBlocking");
      },
    };
    const child: LoadedServerPlugin = {
      id: "test.child",
      dependsOn: [parent],
      sinkHandlers: [sinkHandler(sink, () => (body: string) => log.push(body))],
      onReadyBlocking: () => {
        log.push("child onReadyBlocking");
      },
      onShutdown: () => {
        log.push("child onShutdown");
      },
    };
    await runReadyBarrier([parent, child]);
    expect(log).toEqual([
      "parent onReadyBlocking",
      "attach",
      "child onReadyBlocking",
    ]);
    await runShutdownHooks([parent, child]);
    expect(log.slice(3)).toEqual(["child onShutdown", "detach"]);
  });
});

describe("sinkHandler — one handler per sink", () => {
  test("a second handler on an attached sink throws; the same one re-attaches", () => {
    const sink = { register(_fn: ((body: string) => void) | null) {} };
    const first = sinkHandler(sink, () => (_body: string) => {});
    const second = sinkHandler(sink, () => (_body: string) => {});
    first.attach();
    first.attach();
    expect(() => second.attach()).toThrow(
      "two sinkHandlers attached to one sink",
    );
    first.detach();
    second.attach();
    second.detach();
  });
});
