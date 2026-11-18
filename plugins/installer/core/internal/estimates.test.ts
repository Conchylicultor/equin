import { expect, test } from "bun:test";
import {
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

const timing = (steps: InstallTiming["steps"]): InstallTiming => ({
  v: 1,
  dryRun: false,
  release: null,
  platform: "darwin-arm64",
  at: "2026-11-17T12:00:00Z",
  steps,
});

test("each step's estimate is the median of the runs that measured it, in whole seconds", () => {
  const e = estimatesFrom([
    timing({ mise: 8_000, build: 600_000 }),
    timing({ mise: 10_000, build: 500_000, "build.interface": 200_000 }),
    timing({ mise: 30_000 }),
  ]);
  expect(e.installs).toBe(3);
  expect(e.steps.mise).toBe(10);
  expect(e.steps.build).toBe(550);
  expect(e.steps["build.interface"]).toBe(200);
  // Never measured: no number, never a guess.
  expect(e.steps.tools).toBeNull();
  expect(Object.keys(e.steps).sort()).toEqual(
    [...InstallStepId.options].sort(),
  );
});

test("the committed table names every step", () => {
  expect(Object.keys(INSTALL_ESTIMATES.steps).sort()).toEqual(
    [...InstallStepId.options].sort(),
  );
});

test("install.sh's block is found and round-trips", () => {
  const block = renderEstimatesBlock(
    estimatesFrom([timing({ clone: 41_000 })]),
  );
  expect(block).toContain("    clone) echo 41 ;;");
  expect(block).toContain("    tools) echo null ;;");
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
