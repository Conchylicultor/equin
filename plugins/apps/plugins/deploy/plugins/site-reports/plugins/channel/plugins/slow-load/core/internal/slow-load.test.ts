import { describe, expect, test } from "bun:test";
import {
  judgeHiddenLoad,
  judgeReadyLoad,
  SlowPageLoadPayloadSchema,
  slowPageLoadFingerprint,
  slowPageLoadSummary,
} from "./slow-load";

const phone = {
  client: { family: "safari", os: "ios" },
  connection: "4g",
} as const;
const laptop = {
  client: { family: "chrome", os: "macos" },
  connection: null,
} as const;

describe("judgeReadyLoad", () => {
  test("a load ready under the bar reports nothing", () => {
    expect(
      judgeReadyLoad({ ttfbMs: 200, fcpMs: 900, readyMs: 2_999 }, phone),
    ).toBeNull();
  });

  test("a load ready at the bar or later is reported, named by its largest stretch", () => {
    const server = judgeReadyLoad(
      { ttfbMs: 2_385, fcpMs: 5_980, readyMs: 5_980 },
      phone,
    );
    expect(server?.phase).toBe("first-paint");
    expect(
      judgeReadyLoad({ ttfbMs: 2_500, fcpMs: 3_100, readyMs: 3_400 }, phone)
        ?.phase,
    ).toBe("server");
    expect(
      judgeReadyLoad({ ttfbMs: 100, fcpMs: 600, readyMs: 4_200 }, laptop)
        ?.phase,
    ).toBe("app-ready");
    expect(SlowPageLoadPayloadSchema.parse(server)).toEqual(server!);
  });

  test("measured instants become whole positive ms; unmeasured stay null", () => {
    const p = judgeReadyLoad(
      { ttfbMs: null, fcpMs: 3_000.2, readyMs: 3_000.2 },
      laptop,
    );
    expect(p).toMatchObject({ ttfbMs: null, fcpMs: 3_001, readyMs: 3_001 });
  });
});

describe("judgeHiddenLoad", () => {
  test("hidden before the bar says nothing about the load", () => {
    expect(
      judgeHiddenLoad(
        { ttfbMs: 300, fcpMs: null, readyMs: null },
        1_500,
        phone,
      ),
    ).toBeNull();
  });

  test("hidden after waiting the bar, never ready, is reported as not-ready", () => {
    const p = judgeHiddenLoad(
      { ttfbMs: 300, fcpMs: 2_000, readyMs: null },
      8_000,
      phone,
    );
    expect(p).toMatchObject({
      phase: "not-ready",
      hiddenAtMs: 8_000,
      readyMs: null,
    });
    expect(SlowPageLoadPayloadSchema.parse(p)).toEqual(p!);
  });
});

test("a page never ready past ten minutes is clamped, never dropped", () => {
  const p = judgeHiddenLoad(
    { ttfbMs: 300, fcpMs: null, readyMs: null },
    3_600_000,
    phone,
  );
  expect(p).toMatchObject({ phase: "not-ready", hiddenAtMs: 600_000 });
});

describe("identity and message", () => {
  test("one row per phase and phone or not", () => {
    const a = judgeReadyLoad(
      { ttfbMs: 100, fcpMs: 600, readyMs: 4_200 },
      phone,
    )!;
    const b = judgeReadyLoad(
      { ttfbMs: 90, fcpMs: 700, readyMs: 9_000 },
      phone,
    )!;
    const c = judgeReadyLoad(
      { ttfbMs: 90, fcpMs: 700, readyMs: 9_000 },
      laptop,
    )!;
    expect(slowPageLoadFingerprint(a)).toBe("app-ready:mobile");
    expect(slowPageLoadFingerprint(b)).toBe(slowPageLoadFingerprint(a));
    expect(slowPageLoadFingerprint(c)).toBe("app-ready:desktop");
  });

  test("the message names the time, the stretch and the browser", () => {
    const p = judgeReadyLoad(
      { ttfbMs: 2_385, fcpMs: 5_980, readyMs: 5_980 },
      phone,
    )!;
    expect(slowPageLoadSummary(p)).toBe(
      "Slow page load: ready after 6.0 s (first byte 2.4 s, first paint 6.0 s) — mostly before the first paint; ios/safari, 4g",
    );
  });
});
