import { expect, test } from "bun:test";
import {
  estimatesFrom,
  INSTALL_ESTIMATES,
  type InstallTiming,
} from "./estimates";
import { findEstimatesBlock, renderEstimatesBlock } from "./estimates-block";
import { InstallStepId } from "./events";

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
