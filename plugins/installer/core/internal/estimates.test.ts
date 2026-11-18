import { expect, test } from "bun:test";
import {
  EstimateSet,
  estimateSetOf,
  estimatesFrom,
  INSTALL_ESTIMATES,
  timingFromEvents,
  type InstallTiming,
} from "./estimates";
import { findEstimatesBlock, renderEstimatesBlock } from "./estimates-block";
import {
  InstallStepId,
  parseInstallEventLine,
  type InstallEvent,
} from "./events";

const timing = (
  steps: InstallTiming["steps"],
  platform = "darwin-arm64",
  mode: InstallTiming["mode"] = "window",
): InstallTiming => ({
  v: 1,
  dryRun: false,
  release: null,
  platform,
  mode,
  at: "2026-11-17T12:00:00Z",
  steps,
});

test("each step's estimate is the median of the runs that measured it, in whole seconds", () => {
  const e = estimatesFrom([
    timing({ mise: 8_000, build: 600_000 }),
    timing({ mise: 10_000, build: 500_000, "build.interface": 200_000 }),
    timing({ mise: 30_000 }),
  ]);
  const mw = e.sets["macos-window"];
  expect(mw.installs).toBe(3);
  expect(mw.steps.mise).toBe(10);
  expect(mw.steps.build).toBe(550);
  expect(mw.steps["build.interface"]).toBe(200);
  // Never measured: no number, never a guess.
  expect(mw.steps.tools).toBeNull();
  expect(Object.keys(mw.steps).sort()).toEqual(
    [...InstallStepId.options].sort(),
  );
});

test("each run counts only in its own set: macOS per view, Linux in one", () => {
  const e = estimatesFrom([
    timing({ tools: 166_000 }, "darwin-arm64", "window"),
    timing({ tools: 79_000 }, "darwin-arm64", "interactive"),
    timing({ tools: 81_000 }, "darwin-x86_64", "plain"),
    timing({ tools: 18_000 }, "linux-aarch64", "interactive"),
    timing({ tools: 20_000 }, "linux-x86_64", "window"),
  ]);
  expect(e.sets["macos-window"].steps.tools).toBe(166);
  expect(e.sets["macos-terminal"].steps.tools).toBe(80);
  expect(e.sets.linux.steps.tools).toBe(19);
  expect(e.sets.linux.installs).toBe(2);
  expect(() => estimateSetOf("freebsd-amd64", "window")).toThrow();
});

test("the committed table names every set and every step", () => {
  expect(Object.keys(INSTALL_ESTIMATES.sets).sort()).toEqual(
    [...EstimateSet.options].sort(),
  );
  for (const set of EstimateSet.options)
    expect(Object.keys(INSTALL_ESTIMATES.sets[set].steps).sort()).toEqual(
      [...InstallStepId.options].sort(),
    );
});

test("install.sh's block is found and round-trips", () => {
  const block = renderEstimatesBlock(
    estimatesFrom([timing({ clone: 41_000 })]),
  );
  expect(block).toContain("    macos-window:clone) echo 41 ;;");
  expect(block).toContain("    macos-window:tools) echo null ;;");
  expect(block).toContain("    linux:clone) echo null ;;");
  const script = `#!/bin/bash\nfoo\n${block}\nbar\n`;
  const found = findEstimatesBlock(script);
  expect(found.ok && found.text).toBe(block);
  expect(findEstimatesBlock("no block").ok).toBe(false);
  expect(findEstimatesBlock(`${block}\n${block}`).ok).toBe(false);
});

const PLAN =
  '{"v":1,"t":"2026-11-17T23:13:39Z","type":"plan","release":"v2026.11.17.2","platform":"darwin-arm64","mode":"window","groups":[{"id":"prepare","label":"Prepare your Mac"}],"steps":[{"id":"tools","label":"Prepare your Mac","doing":"Installing","group":"prepare","est_s":null}]}';
const events = (...lines: string[]): InstallEvent[] =>
  lines.map((line) => {
    const parsed = parseInstallEventLine(line);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.event;
  });
const step = (id: string, ms: number) =>
  `{"v":1,"t":"2026-11-17T23:17:10Z","type":"step","id":"${id}","state":"done","ms":${ms}}`;
const DONE =
  '{"v":1,"t":"2026-11-17T23:42:18Z","type":"done","url":"http://equin.localhost:8700","ms":1719000}';

test("a finished stream's timing is each step's last done time", () => {
  const r = timingFromEvents(
    events(
      PLAN,
      step("tools", 211_000),
      '{"v":1,"t":"2026-11-17T23:17:10Z","type":"step","id":"mise","state":"skipped"}',
      step("clone", 9_000),
      step("clone", 16_000),
      DONE,
    ),
  );
  expect(r).toEqual({
    ok: true,
    timing: {
      v: 1,
      dryRun: false,
      release: "v2026.11.17.2",
      platform: "darwin-arm64",
      mode: "window",
      at: "2026-11-17T23:42:18Z",
      steps: { tools: 211_000, clone: 16_000 },
    },
  });
});

test("an unfinished stream measures nothing; a dry run's stream says so", () => {
  expect(timingFromEvents(events(PLAN, step("tools", 1_000))).ok).toBe(false);
  const dry = timingFromEvents(
    events(
      PLAN.replace('"mode":"window"', '"mode":"window","dryRun":true'),
      DONE,
    ),
  );
  expect(dry.ok && dry.timing.dryRun).toBe(true);
});

const skipped = (id: string) =>
  `{"v":1,"t":"2026-11-17T23:17:10Z","type":"step","id":"${id}","state":"skipped"}`;

test("a build sub-step skipped inside a finished build took 0; a skipped top step is not measured", () => {
  const r = timingFromEvents(
    events(
      PLAN,
      skipped("tools"),
      skipped("build.database"),
      step("build.deps", 4_000),
      skipped("build.deps"),
      skipped("build.deploy"),
      step("build.deploy", 3_000),
      step("build", 2_000),
      DONE,
    ),
  );
  expect(r.ok && r.timing.steps).toEqual({
    build: 2_000,
    "build.database": 0,
    "build.deps": 0,
    "build.deploy": 3_000,
  });
  // A build that never finished measured none of its sub-steps.
  const unfinished = timingFromEvents(
    events(PLAN, skipped("build.database"), DONE),
  );
  expect(unfinished.ok && unfinished.timing.steps).toEqual({});
});
