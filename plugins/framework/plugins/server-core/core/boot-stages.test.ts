import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineResource } from "./resources";
import { bootPluginGraph } from "./boot-stages";
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
