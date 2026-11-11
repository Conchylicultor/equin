import { expect, test } from "bun:test";
import { detectStepRegressions } from "./detect";
import {
  readBuildSteps,
  type BuildSteps,
  type ProfileSpanLike,
  type StepFsCalls,
} from "./steps";

const HOUR = 3_600_000;

function fs(total: number, prefix = "~/cache/store"): StepFsCalls {
  return {
    stat: total,
    readdir: 0,
    read: 0,
    glob: 0,
    total,
    top: total >= 100 ? [{ prefix, calls: total }] : [],
  };
}

function build(
  i: number,
  steps: Record<string, { ms: number; calls?: number; prefix?: string }>,
  stale = 0,
): BuildSteps {
  const spans: ProfileSpanLike[] = [
    {
      id: "artifacts:build",
      phase: "build:frontend",
      label: `build artifacts (${stale} stale)`,
      startMs: 0,
      durationMs: 500,
    },
    {
      id: "acquireHostGrant",
      phase: "build:setup",
      label: "wait for host CPU grant",
      startMs: 0,
      durationMs: i === 99 ? 900_000 : 10,
      wait: true,
    },
  ];
  for (const [id, s] of Object.entries(steps))
    spans.push({
      id,
      phase: "build:frontend",
      label: id,
      startMs: 0,
      durationMs: s.ms,
      ...(s.calls !== undefined ? { fs: fs(s.calls, s.prefix) } : {}),
    });
  return readBuildSteps(`build-${1794000000 + i}-x`, i * HOUR, { spans });
}

const healthy = (i: number) =>
  build(i, {
    "artifacts:detect": { ms: 20_000 + (i % 3) * 1000, calls: 3_000 },
  });
const history = Array.from({ length: 20 }, (_, i) => healthy(i));

test("a step that stays 8× slower in two same-work builds fires, naming its baseline", () => {
  const slow1 = build(20, {
    "artifacts:detect": { ms: 170_000, calls: 3_000 },
  });
  const slow2 = build(21, {
    "artifacts:detect": { ms: 165_000, calls: 3_000 },
  });
  expect(detectStepRegressions(slow1, history)).toEqual([]); // once is a blip
  const found = detectStepRegressions(slow2, [...history, slow1]);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    step: "artifacts:detect",
    metric: "time",
    value: 165_000,
    baseline: 21_000,
  });
});

test("a build that rebuilt artifacts is neither judged nor a baseline", () => {
  const rebuilt = (i: number) =>
    build(i, { "artifacts:detect": { ms: 170_000 } }, 12);
  expect(detectStepRegressions(rebuilt(21), [...history, rebuilt(20)])).toEqual(
    [],
  );
  // …and a rebuilt build between two slow same-work builds does not break the run.
  const slow = (i: number) =>
    build(i, { "artifacts:detect": { ms: 170_000, calls: 3_000 } });
  expect(
    detectStepRegressions(slow(22), [...history, slow(20), rebuilt(21)]),
  ).toHaveLength(1);
});

test("waits are not steps: a 15-minute host-grant queue judges nothing", () => {
  const queued = build(99, { "artifacts:detect": { ms: 21_000 } });
  expect(queued.steps.has("acquireHostGrant")).toBe(false);
  expect(detectStepRegressions(queued, history)).toEqual([]);
});

test("file calls that jump in builds that rebuilt nothing fire, with the prefix that grew", () => {
  const leaky = (i: number) =>
    build(i, {
      "artifacts:detect": {
        ms: 21_000,
        calls: 450_000,
        prefix: "~/fleet/checkouts/main",
      },
    });
  const found = detectStepRegressions(leaky(21), [...history, leaky(20)]);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    metric: "fs-calls",
    value: 450_000,
    baseline: 3_000,
    increases: [
      {
        prefix: "~/fleet/checkouts/main",
        calls: 450_000,
        baselineCalls: 0,
      },
    ],
  });
});

test("too short a history, or a small absolute jump, is no verdict", () => {
  const slow = (i: number) =>
    build(i, { "artifacts:detect": { ms: 170_000, calls: 3_000 } });
  expect(
    detectStepRegressions(slow(5), [...history.slice(0, 3), slow(4)]),
  ).toEqual([]);
  const tiny = (i: number) =>
    build(i, { "artifacts:detect": { ms: 20_000, calls: 8_000 } });
  // ×2.7 calls and +5,000 — both bars, exactly met:
  expect(detectStepRegressions(tiny(21), [...history, tiny(20)])).toHaveLength(
    1,
  );
  const tinier = (i: number) =>
    build(i, { "artifacts:detect": { ms: 20_000, calls: 7_000 } });
  expect(detectStepRegressions(tinier(21), [...history, tinier(20)])).toEqual(
    [],
  );
});

test("a profile written before spans marked their waits reads the known waits as waits", () => {
  const old = readBuildSteps("build-1793000000-x", 0, {
    spans: [
      {
        id: "adoptDeploy",
        phase: "build:deploy",
        label: "ask",
        startMs: 0,
        durationMs: 40_000,
      },
      {
        id: "check:type-check",
        phase: "build:checks",
        label: "type-check",
        startMs: 0,
        durationMs: 1,
      },
      {
        id: "pluginDocs",
        phase: "build:validation",
        label: "docs",
        startMs: 0,
        durationMs: 9_000,
      },
    ],
  });
  expect([...old.steps.keys()]).toEqual(["pluginDocs"]);
  expect(old.rebuiltNothing).toBeNull();
});
