import { describe, expect, test } from "bun:test";
import {
  fallbackVerdict,
  orderStepsForDisplay,
  renderStepBlock,
  renderVerdict,
  runVerdictGuard,
  type Verdict,
} from "./build-output";
import type { SignalTermination } from "./fatal-signals";

const URL = "http://att-x.localhost:9000";

const sigterm: SignalTermination = {
  signal: "SIGTERM",
  at: "2026-08-06T15:18:25.236Z",
};

function failureVerdict(steps: Verdict["steps"], viteOnly = false): Verdict {
  return {
    ok: false,
    headline: "BUILD FAILED — checks",
    reason: [
      `NOT DEPLOYED. Nothing was published; ${URL} still serves the previous build.`,
      viteOnly ? "The frontend compiled, but the artifact was discarded." : "",
    ].filter(Boolean),
    pointers: [
      "Full output: /home/x/.equin/worktrees/att-x/build.log",
      "Check logs:  /home/x/.equin/worktrees/att-x/check.log",
    ],
    steps,
  };
}

describe("orderStepsForDisplay", () => {
  test("failures last, stable within each group", () => {
    const steps = [
      { label: "a", success: true },
      { label: "b", success: false },
      { label: "c", success: true },
      { label: "d", success: false },
    ];
    expect(orderStepsForDisplay(steps).map((s) => s.label)).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  test("does not mutate its input", () => {
    const steps = [
      { label: "a", success: false },
      { label: "b", success: true },
    ];
    orderStepsForDisplay(steps);
    expect(steps.map((s) => s.label)).toEqual(["a", "b"]);
  });
});

describe("renderStepBlock", () => {
  test("prefixes every replayed line with `│ ` and preserves each stream", () => {
    const block = renderStepBlock({
      id: "viteBuild",
      label: "vite build",
      durationMs: 72_200,
      success: true,
      lines: [
        { text: "vite v6.0.1 building for production...", stream: "stdout" },
        { text: "✓ built in 72.2s", stream: "stdout" },
        { text: "a warning", stream: "stderr" },
      ],
    });
    const [header, ...replay] = block;
    // Assert the header exists, then narrow — the test reads header.stream/.text,
    // so a missing header must fail loudly rather than throw a cryptic undefined.
    if (!header) throw new Error("renderStepBlock must return a header line");
    expect(header.stream).toBe("stdout");
    expect(header.text.startsWith("── vite build ✓")).toBe(true);
    for (const line of replay) expect(line.text.startsWith("│ ")).toBe(true);
    // The borrowed `✓ built` line is quoted, not a bare success line.
    expect(replay.some((l) => l.text === "│ ✓ built in 72.2s")).toBe(true);
    expect(replay.find((l) => l.text.includes("a warning"))?.stream).toBe(
      "stderr",
    );
  });
});

describe("renderVerdict — failure", () => {
  test("last lines are exactly the pointers", () => {
    const v = failureVerdict([
      { label: "checks", success: false },
      { label: "vite build", success: true },
    ]);
    const lines = renderVerdict(v).split("\n");
    expect(lines.slice(-v.pointers.length)).toEqual(
      v.pointers.map((p) => `  ${p}`),
    );
  });

  test("contains NOT DEPLOYED, the worktree URL, and a roster entry per step", () => {
    const v = failureVerdict([
      { label: "checks", success: false },
      { label: "vite build", success: true },
    ]);
    const out = renderVerdict(v);
    expect(out).toContain("NOT DEPLOYED");
    expect(out).toContain(URL);
    expect(out).toContain("checks ✗");
    expect(out).toContain("vite build ✓");
  });

  test("a passing vite step has no bare ✓-line outside a `│ ` quote", () => {
    // The verdict never replays step lines; only renderStepBlock does, and it
    // quotes every one. So a rendered verdict of a failure where vite passed
    // carries vite's success only as the roster glyph `vite build ✓`, never a
    // free-standing `✓ built`.
    const v = failureVerdict([
      { label: "checks", success: false },
      { label: "vite build", success: true },
    ]);
    for (const line of renderVerdict(v).split("\n")) {
      if (line.includes("built")) expect(line.startsWith("│ ")).toBe(true);
    }
  });
});

describe("renderVerdict — box width", () => {
  test("a headline longer than 60 chars is not clipped", () => {
    const headline = "BUILD FAILED — " + "x".repeat(80);
    const out = renderVerdict({
      ok: false,
      headline,
      reason: ["short"],
      pointers: ["Full output: /tmp/build.log"],
      steps: [{ label: "checks", success: false }],
    });
    const boxRow = out.split("\n").find((l) => l.startsWith("║"))!;
    expect(boxRow).toContain(headline);
    const topBorder = out.split("\n")[0];
    if (topBorder === undefined)
      throw new Error("renderVerdict produced no output");
    expect(topBorder.length).toBeGreaterThanOrEqual(headline.length);
  });
});

describe("renderVerdict — success", () => {
  test("contains BUILD OK and the url", () => {
    const out = renderVerdict({
      ok: true,
      headline: "BUILD OK — deployed",
      notes: [URL],
      pointers: [],
      steps: [
        { label: "checks", success: true },
        { label: "vite build", success: true },
      ],
    });
    expect(out).toContain("BUILD OK");
    expect(out).toContain(URL);
  });
});

describe("fallbackVerdict", () => {
  const ctx = {
    urls: [URL],
    buildLogPath: "/home/x/.equin/worktrees/att-x/build.log",
  };

  // Narrows Verdict | null and fails loudly instead of papering over with `!`.
  function requireVerdict(v: Verdict | null): Verdict {
    if (v === null) throw new Error("expected a non-null fallback verdict");
    return v;
  }

  test("agreeing (ok:true, exit 0) → null", () => {
    expect(fallbackVerdict({ ok: true }, 0, ctx)).toBeNull();
  });

  test("agreeing (ok:false, exit 1) → null", () => {
    expect(fallbackVerdict({ ok: false }, 1, ctx)).toBeNull();
  });

  test("(no verdict, exit 1) → aborted-before-completing headline, NOT DEPLOYED reason", () => {
    const v = requireVerdict(fallbackVerdict(null, 1, ctx));
    expect(v.headline).toContain("aborted before completing");
    const reason = v.ok ? v.notes : v.reason;
    expect(reason.join("\n")).toContain("NOT DEPLOYED");
  });

  test("(no verdict, exit 0) → This is a bug", () => {
    const v = requireVerdict(fallbackVerdict(null, 0, ctx));
    expect(renderVerdict(v)).toContain("This is a bug");
  });

  test("(ok:false, exit 0) → This is a bug", () => {
    const v = requireVerdict(fallbackVerdict({ ok: false }, 0, ctx));
    expect(renderVerdict(v)).toContain("This is a bug");
  });

  test("(ok:true, exit 3) → This is a bug", () => {
    const v = requireVerdict(fallbackVerdict({ ok: true }, 3, ctx));
    expect(renderVerdict(v)).toContain("This is a bug");
  });

  test("every non-null fallback's rendered last line is the Full output pointer", () => {
    const cases: Array<{
      emitted: { ok: boolean } | null;
      code: number;
      termination?: SignalTermination;
    }> = [
      { emitted: null, code: 1 },
      { emitted: null, code: 0 },
      { emitted: { ok: false }, code: 0 },
      { emitted: { ok: true }, code: 3 },
      { emitted: null, code: 143, termination: sigterm },
    ];
    for (const { emitted, code, termination } of cases) {
      const v = requireVerdict(
        fallbackVerdict(emitted, code, ctx, termination),
      );
      const lines = renderVerdict(v).split("\n");
      expect(lines.at(-1)).toBe(`  Full output: ${ctx.buildLogPath}`);
    }
  });
});

// The pointer above is only true if something wrote the file it names. That is
// the guard's other half, so it is asserted against the SAME set of arms: a
// pointer and a write, bound in one test.
describe("runVerdictGuard — the pointer and the file it names", () => {
  const ctx = {
    urls: [URL],
    buildLogPath: "/home/x/.equin/worktrees/att-x/build.log",
  };

  test("every fallback carrying the pointer has a write behind it", () => {
    const cases: Array<{
      emitted: { ok: boolean } | null;
      code: number;
      termination?: SignalTermination;
    }> = [
      { emitted: null, code: 1 },
      { emitted: null, code: 0 },
      { emitted: { ok: false }, code: 0 },
      { emitted: { ok: true }, code: 3 },
      { emitted: null, code: 143, termination: sigterm },
    ];
    for (const { emitted, code, termination } of cases) {
      const wrote: Array<{ verdict: Verdict; code: number }> = [];
      const v = runVerdictGuard(emitted, code, {
        ...ctx,
        termination: () => termination ?? null,
        onFallback: (verdict, c) => wrote.push({ verdict, code: c }),
      });
      if (v === null) throw new Error("expected a non-null fallback verdict");
      expect(renderVerdict(v).split("\n").at(-1)).toBe(
        `  Full output: ${ctx.buildLogPath}`,
      );
      // Nothing emitted ⇒ the build reached neither of build.ts's own
      // writeBuildLogs calls ⇒ the guard is the only thing that can write the
      // file, and must. Something emitted ⇒ that path already wrote it, and a
      // second write would only churn the trailer.
      expect(wrote).toEqual(emitted === null ? [{ verdict: v, code }] : []);
    }
  });

  test("an agreeing verdict neither prints nor writes", () => {
    const wrote: Verdict[] = [];
    const onFallback = (v: Verdict): number => wrote.push(v);
    expect(runVerdictGuard({ ok: true }, 0, { ...ctx, onFallback })).toBeNull();
    expect(
      runVerdictGuard({ ok: false }, 1, { ...ctx, onFallback }),
    ).toBeNull();
    expect(wrote).toEqual([]);
  });

  test("the killed build writes its SIGNAL code, not a guessed failure code", () => {
    // The whole reason the artifact carries an exit code: the steps a killed
    // build closed are all green, so anything deriving the outcome from them
    // would file this 143 as a successful deploy.
    const codes: number[] = [];
    runVerdictGuard(null, 143, {
      ...ctx,
      termination: () => sigterm,
      onFallback: (_v, code) => void codes.push(code),
    });
    expect(codes).toEqual([143]);
  });
});

// The incident shape: SIGTERM at 19 minutes, exit 143, no verdict of its own.
// It must never read as a code defect.
describe("fallbackVerdict — terminated from outside", () => {
  const ctx = {
    urls: [URL],
    buildLogPath: "/home/x/.equin/worktrees/att-x/build.log",
  };

  test("(no verdict, exit 143, SIGTERM) → BUILD ABORTED, not BUILD FAILED", () => {
    const v = fallbackVerdict(null, 143, ctx, sigterm);
    if (v === null) throw new Error("expected a non-null fallback verdict");
    expect(v.headline).toBe("BUILD ABORTED — terminated by SIGTERM");
    expect(v.headline).not.toContain("FAILED");
    const reason = (v.ok ? v.notes : v.reason).join("\n");
    expect(reason).toContain("NOT DEPLOYED");
    // The load-bearing sentence: this is not a build defect.
    expect(reason).toContain("did NOT fail");
    expect(reason).toContain("ended from outside");
    expect(reason).toContain(sigterm.at);
    expect(reason).not.toContain("This is a bug");
  });

  test("no attribution yet ⇒ says the sender is unknown, invents nothing", () => {
    const v = fallbackVerdict(null, 143, ctx, sigterm);
    if (v === null) throw new Error("expected a non-null fallback verdict");
    expect((v.ok ? v.notes : v.reason).join("\n")).toContain(
      "sender is unknown",
    );
  });

  test("an attribution, once recorded, is named", () => {
    const v = fallbackVerdict(null, 143, ctx, {
      ...sigterm,
      attribution: "pid 41234 /bin/kill ← 41198 bun (att-1786028928-88pa)",
    });
    if (v === null) throw new Error("expected a non-null fallback verdict");
    const reason = (v.ok ? v.notes : v.reason).join("\n");
    expect(reason).toContain("Sent by pid 41234 /bin/kill");
    expect(reason).not.toContain("sender is unknown");
  });

  test("without a termination fact the old aborted-before-completing wording stands", () => {
    const v = fallbackVerdict(null, 143, ctx);
    if (v === null) throw new Error("expected a non-null fallback verdict");
    expect(v.headline).toContain("aborted before completing");
  });

  test("the bug-banner arms are unaffected by a termination fact", () => {
    // build.ts contradicting itself stays a bug regardless of who signalled it.
    for (const emitted of [null, { ok: false }] as const) {
      const v = fallbackVerdict(emitted, 0, ctx, sigterm);
      if (v === null) throw new Error("expected a non-null fallback verdict");
      expect(v.headline).toContain("This is a bug");
    }
    const reportedOk = fallbackVerdict({ ok: true }, 143, ctx, sigterm);
    if (reportedOk === null)
      throw new Error("expected a non-null fallback verdict");
    expect(reportedOk.headline).toContain("This is a bug");
  });

  test("the agreeing cases stay null even with a termination fact", () => {
    expect(fallbackVerdict({ ok: true }, 0, ctx, sigterm)).toBeNull();
    expect(fallbackVerdict({ ok: false }, 143, ctx, sigterm)).toBeNull();
  });
});

// A build that throws before its own failure funnel used to produce a banner (and a
// build.log) that named no step, no check and no error — the transcript said a build
// failed and nothing about why. The recorded exception is what makes that arm say
// something.
describe("fallbackVerdict — crashed on an unhandled exception", () => {
  const ctx = {
    urls: ["http://main.localhost:9000"],
    buildLogPath: "/tmp/build.log",
  };
  const crash =
    "Error: createHostSemaphore(cpu): pool is live at 11:8\n    at doEnsureSizeIdentity";

  test("(no verdict, exit 1, crash) → the exception is quoted in the reason", () => {
    const v = fallbackVerdict(null, 1, ctx, null, crash);
    if (v === null) throw new Error("expected a non-null fallback verdict");
    expect(v.headline).toContain("crashed before completing");
    const reason = (v.ok ? v.notes : v.reason).join("\n");
    expect(reason).toContain("NOT DEPLOYED");
    expect(reason).toContain("unhandled exception");
    expect(reason).toContain("pool is live at 11:8");
    expect(reason).toContain("at doEnsureSizeIdentity");
  });

  test("no recorded crash ⇒ the aborted-before-completing wording is unchanged", () => {
    const v = fallbackVerdict(null, 1, ctx, null, null);
    if (v === null) throw new Error("expected a non-null fallback verdict");
    expect(v.headline).toContain("aborted before completing");
    expect((v.ok ? v.notes : v.reason).join("\n")).not.toContain("exception");
  });

  test("a signal outranks a crash record — a killed build did not fail", () => {
    // Both facts can be present (a SIGTERM handler's own unwind records a throw);
    // BUILD ABORTED must still win, or a kill reads as a code defect.
    const v = fallbackVerdict(null, 143, ctx, sigterm, crash);
    if (v === null) throw new Error("expected a non-null fallback verdict");
    expect(v.headline).toBe("BUILD ABORTED — terminated by SIGTERM");
  });
});
