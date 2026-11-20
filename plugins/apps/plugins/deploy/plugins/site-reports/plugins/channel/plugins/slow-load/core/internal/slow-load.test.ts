import { describe, expect, test } from "bun:test";
import {
  judgeHiddenLoad,
  judgeLoad,
  judgeReadyLoad,
  SlowPageLoadPayloadSchema,
  slowPageLoadFingerprint,
  slowPageLoadSummary,
} from "./slow-load";

const phone = {
  firstByte: null,
  client: { family: "safari", os: "ios" },
  connection: "4g",
} as const;
const laptop = {
  firstByte: null,
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

describe("the first byte's split", () => {
  test("rides the payload and names its parts in the summary", () => {
    const firstByte = {
      totalMs: 3_297,
      beforeFetchMs: 0,
      dnsMs: 412,
      tcpMs: 905,
      tlsMs: 910,
      waitMs: 1_050,
      otherMs: 20,
      protocol: "h2",
    };
    const p = judgeReadyLoad(
      { ttfbMs: 3_297, fcpMs: 10_074, readyMs: 10_074 },
      { ...laptop, firstByte },
    );
    expect(p?.firstByte).toEqual(firstByte);
    expect(SlowPageLoadPayloadSchema.parse(p)).toEqual(p!);
    expect(slowPageLoadSummary(p!)).toContain(
      "[first byte: DNS 412 ms + TCP 905 ms + TLS 910 ms + request→response 1050 ms + other 20 ms over h2]",
    );
  });

  test("a report filed before the split existed still parses, as null", () => {
    const p = judgeReadyLoad(
      { ttfbMs: 2_500, fcpMs: 3_100, readyMs: 3_400 },
      phone,
    )!;
    const { firstByte: _, ...old } = p;
    expect(SlowPageLoadPayloadSchema.parse(old).firstByte).toBeNull();
  });
});

describe("judgeLoad — only what the visitor could see is judged", () => {
  const shown = { kind: "shown" } as const;
  const hiddenAt = (atMs: number) => ({ kind: "hidden", atMs }) as const;
  const ctx = { ...laptop, awaitPaint: true };

  test("visible throughout: judged on ready, slow at the bar", () => {
    expect(
      judgeLoad({ ttfbMs: 200, fcpMs: 900, readyMs: 1_500 }, shown, ctx),
    ).toEqual({ kind: "fast" });
    const v = judgeLoad(
      { ttfbMs: 200, fcpMs: 4_000, readyMs: 4_000 },
      shown,
      ctx,
    );
    expect(v.kind === "slow" && v.payload.phase).toBe("first-paint");
  });

  test("not ready yet and visible: pending (waits for paint where it is timed)", () => {
    expect(
      judgeLoad({ ttfbMs: 200, fcpMs: null, readyMs: null }, shown, ctx).kind,
    ).toBe("pending");
    expect(
      judgeLoad({ ttfbMs: 200, fcpMs: null, readyMs: 800 }, shown, ctx).kind,
    ).toBe("pending");
  });

  test("ready before the first hide is a ready load", () => {
    const v = judgeLoad(
      { ttfbMs: 300, fcpMs: 3_500, readyMs: 3_500 },
      hiddenAt(9_000),
      ctx,
    );
    expect(v.kind === "slow" && v.payload.readyMs).toBe(3_500);
  });

  test("hidden before ready and before the bar: no one waited — a background load", () => {
    // Opened in the background (hidden from 0), or switched away right after
    // the click: its first paint is the visitor coming back, minutes later.
    for (const at of [0, 400, 2_999]) {
      expect(
        judgeLoad(
          { ttfbMs: 450, fcpMs: 261_236, readyMs: 261_236 },
          hiddenAt(at),
          ctx,
        ),
      ).toEqual({ kind: "not-waited", reason: "background-load" });
    }
  });

  test("hidden before ready after waiting the bar: not-ready, at the hide, paint after it ignored", () => {
    const v = judgeLoad(
      { ttfbMs: 100, fcpMs: 183_400, readyMs: 183_400 },
      hiddenAt(5_421),
      ctx,
    );
    expect(v.kind).toBe("slow");
    if (v.kind !== "slow") return;
    expect(v.payload).toMatchObject({
      phase: "not-ready",
      hiddenAtMs: 5_421,
      fcpMs: null,
      readyMs: null,
      ttfbMs: 100,
    });
  });

  test("a prerendered load is never judged", () => {
    expect(
      judgeLoad(
        { ttfbMs: 200, fcpMs: 183_400, readyMs: 183_400 },
        { kind: "prerendered" },
        ctx,
      ),
    ).toEqual({ kind: "not-waited", reason: "prerendered-load" });
  });

  // The slow-page-load occurrences equin.ai recorded (main's reports, latest
  // sample per row, 2026-11-19/20), replayed: the real 3–11 s loads are kept
  // on a page visible throughout; the minutes-long ones, whose first paint
  // came only when the tab was shown, are dropped once the record shows the
  // page hidden before it was ready.
  const recorded = [
    { id: "4ub9k8", ttfbMs: 704, fcpMs: 6_839, readyMs: 6_839, real: true },
    { id: "82si50", ttfbMs: 9_821, fcpMs: 10_849, readyMs: 10_849, real: true },
    { id: "z70nni", ttfbMs: 1_906, fcpMs: 3_120, readyMs: 3_120, real: true },
    {
      id: "sh7lst",
      ttfbMs: 459,
      fcpMs: 261_236,
      readyMs: 261_236,
      real: false,
    },
    {
      id: "sh7lst@08:50",
      ttfbMs: 200,
      fcpMs: 183_400,
      readyMs: 183_400,
      real: false,
    },
  ];
  test.each(recorded)("replay $id", ({ ttfbMs, fcpMs, readyMs, real }) => {
    const m = { ttfbMs, fcpMs, readyMs };
    if (real) {
      expect(judgeLoad(m, shown, ctx).kind).toBe("slow");
    } else {
      // Visible at the navigation, hidden before the app mounted (what the old
      // reporter missed: it looked only at the first visibility entry and
      // subscribed at mount), or opened in the background.
      for (const shownAs of [
        hiddenAt(0),
        hiddenAt(1_200),
        { kind: "prerendered" } as const,
      ]) {
        expect(judgeLoad(m, shownAs, ctx).kind).toBe("not-waited");
      }
    }
  });
});
