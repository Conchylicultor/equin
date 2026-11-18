// bun:test suite for the boot-hook scope (`runBootHook`): which `runTracked`
// work a boot hook leaves running when it returns. The AsyncLocalStorage
// runtime is injected HERE, exactly the way server/internal/install.ts does.
import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  installBootHookScopeRuntime,
  runBootHook,
  runTracked,
  type BootHookScope,
} from "./recorder";

const als = new AsyncLocalStorage<BootHookScope | undefined>();
installBootHookScopeRuntime({
  run: (scope, fn) => als.run(scope, fn),
  current: () => als.getStore(),
});

/** A promise and its resolver, for work held open until the test says. */
function gate(): { wait: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: promise, open: () => resolve() };
}

describe("runBootHook — the work a boot hook leaves running", () => {
  test("awaited work is not left running", async () => {
    const { leftRunning } = await runBootHook(async () => {
      await runTracked("awaited", async () => {
        await Promise.resolve();
      });
    });
    expect(leftRunning).toEqual([]);
  });

  test("a detached runTracked, however deep in the hook's call chain, is named", async () => {
    const held = gate();
    const startHelper = (): void => {
      void runTracked("helper:first-pass", () => held.wait);
    };
    const { leftRunning } = await runBootHook(async () => {
      await Promise.resolve();
      startHelper();
    });
    expect(leftRunning).toEqual(["helper:first-pass"]);
    held.open();
  });

  test("detached work that settled before the hook returned is not named", async () => {
    const { leftRunning } = await runBootHook(async () => {
      void runTracked("quick", () => undefined);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(leftRunning).toEqual([]);
  });

  test("work declared outlivesBootHook is not named, nor what it starts", async () => {
    const held = gate();
    const { leftRunning } = await runBootHook(() => {
      void runTracked(
        "service:connect",
        () => {
          void runTracked("service:child", () => held.wait);
          return held.wait;
        },
        { outlivesBootHook: "the test's long-lived service" },
      );
    });
    expect(leftRunning).toEqual([]);
    held.open();
  });

  test("work started after the hook returned is not the hook's", async () => {
    const held = gate();
    const later = gate();
    const { leftRunning } = await runBootHook(() => {
      // Like a timer the hook arms: its tick runs in the hook's async context,
      // but after the hook returned.
      void later.wait.then(() => runTracked("tick", () => held.wait));
    });
    later.open();
    await Promise.resolve();
    expect(leftRunning).toEqual([]);
    held.open();
  });

  test("a hook that throws throws", () => {
    expect(
      runBootHook(() => Promise.reject(new Error("hook broke"))),
    ).rejects.toThrow("hook broke");
  });
});
