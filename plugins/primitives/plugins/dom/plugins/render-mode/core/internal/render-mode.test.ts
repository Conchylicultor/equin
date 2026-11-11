import { describe, expect, test } from "bun:test";

// Each case imports a fresh module instance: the mode is process-wide state.
async function fresh(): Promise<typeof import("./render-mode")> {
  return import(`./render-mode?case=${crypto.randomUUID()}`);
}

describe("render-mode", () => {
  test("defaults to live", async () => {
    const m = await fresh();
    expect(m.renderMode()).toBe("live");
  });

  test("a declared static render reads static", async () => {
    const m = await fresh();
    m.declareRenderMode("static");
    expect(m.renderMode()).toBe("static");
  });

  test("a second declaration throws", async () => {
    const m = await fresh();
    m.declareRenderMode("static");
    expect(() => m.declareRenderMode("static")).toThrow(/declared twice/);
  });

  test("declaring after the first read throws", async () => {
    const m = await fresh();
    m.renderMode();
    expect(() => m.declareRenderMode("static")).toThrow(
      /after the mode was already read/,
    );
  });
});
