import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  clearCollectedContributions,
  collectContributions,
} from "./contributions";
import {
  assertHostServices,
  defineHostService,
  provideHostServicesUnbooted,
} from "./host-service";
import { isolateHostServices } from "./testing/host-services";

// Services are declared once per process (module scope), and the assert checks
// every declared one — so every test below provides for each of them except
// the one it is about. Forget the services other modules (the `bun test`
// preload's desktop providers) declared first, so they are not demanded here —
// and get them back after, with this suite's own forgotten.
isolateHostServices();
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
afterAll(() => clearCollectedContributions());

describe("defineHostService", () => {
  test("get() with no booted graph and no unbooted provider throws, naming it", () => {
    // The preload's unbooted host provides no `test.clock`.
    expect(() => Clock.get()).toThrow(/"test\.clock" has no provider/);
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

  test("a collect that no boot assert proved does not answer: the unbooted host does", () => {
    // A suite collects a few contributions of its own to drive booted code —
    // no providers among them. Host services stay the process's.
    const previous = provideHostServicesUnbooted([Clock.provide(clock)]);
    try {
      collectContributions([provider("hooks-only")]);
      expect(Clock.get().now()).toBe(42);
    } finally {
      provideHostServicesUnbooted(previous);
    }
  });

  test("a booted graph, once cleared, is gone: the unbooted host answers", () => {
    collectContributions([
      provider("clock-host", Clock.provide({ now: () => 1 })),
      provider("store-host", Store.provide({ name: "s" })),
    ]);
    assertHostServices();
    expect(Clock.get().now()).toBe(1);
    clearCollectedContributions();
    const previous = provideHostServicesUnbooted([Clock.provide(clock)]);
    try {
      // The next suite's own collect, with no boot behind it.
      collectContributions([provider("hooks-only")]);
      expect(Clock.get().now()).toBe(42);
    } finally {
      provideHostServicesUnbooted(previous);
    }
  });

  test("a collect over a booted graph with no clear or re-assert between fails loudly, never switching providers", () => {
    collectContributions([
      provider("clock-host", Clock.provide({ now: () => 1 })),
      provider("store-host", Store.provide({ name: "s" })),
    ]);
    assertHostServices();
    const previous = provideHostServicesUnbooted([Clock.provide(clock)]);
    try {
      collectContributions([provider("hooks-only")]);
      expect(() => Clock.get()).toThrow(
        /collected again over a booted graph, with no boot assert since/,
      );
    } finally {
      provideHostServicesUnbooted(previous);
    }
  });

  test("an id names one service", () => {
    expect(() => defineHostService("test.clock")).toThrow(/defined twice/);
  });
});
