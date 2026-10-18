import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  clearCollectedContributions,
  collectContributions,
} from "./contributions";
import {
  assertHostServices,
  clearHostServices,
  defineHostService,
} from "./host-service";

// Services are declared once per process (module scope), and the assert checks
// every declared one — so every test below provides for each of them except
// the one it is about. Forget the services other modules (the `bun test`
// preload's desktop providers) declared first, so they are not demanded here.
clearHostServices();
const Clock = defineHostService<{ now(): number }>("test.clock");
const Store = defineHostService<{ name: string }>("test.store");

const clock = { now: () => 42 };
const provider = (
  id: string,
  ...contributions: ReturnType<typeof Clock.provide>[]
) => ({
  id,
  contributions,
});

beforeEach(() => clearCollectedContributions());
afterAll(() => {
  clearCollectedContributions();
  clearHostServices();
});

describe("defineHostService", () => {
  test("get() before contributions are collected throws", () => {
    expect(() => Clock.get()).toThrow(
      /"test\.clock" read before boot collected contributions/,
    );
  });

  test("get() returns the one provider's implementation", () => {
    collectContributions([
      provider("clock-host", Clock.provide(clock)),
      provider("store-host", Store.provide({ name: "s" })),
    ]);
    assertHostServices();
    expect(Clock.get().now()).toBe(42);
    expect(Store.get().name).toBe("s");
  });

  test("a service with no provider fails the boot assert, naming it", () => {
    collectContributions([provider("clock-host", Clock.provide(clock))]);
    expect(() => assertHostServices()).toThrow(/"test\.store" has no provider/);
  });

  test("a service with two providers fails the boot assert, naming both plugins", () => {
    collectContributions([
      provider("clock-a", Clock.provide(clock)),
      provider("clock-b", Clock.provide(clock)),
      provider("store-host", Store.provide({ name: "s" })),
    ]);
    expect(() => assertHostServices()).toThrow(
      /"test\.clock" has 2 providers \(clock-a, clock-b\)/,
    );
  });

  test("an id names one service", () => {
    expect(() => defineHostService("test.clock")).toThrow(/defined twice/);
  });
});
