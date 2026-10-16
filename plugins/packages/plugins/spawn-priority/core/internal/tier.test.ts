import { test, expect } from "bun:test";
import { backgroundArgv } from "./background";
import { spawnAtTier } from "./tier";

// The argv each tier hands the spawn call. `foreground` is never prefixed: its
// lift is the process's own (see darwin-background.test.ts), not a wrapper.

const argv = ["echo", "hi"];
const seen = (tier: Parameters<typeof spawnAtTier>[0]) =>
  spawnAtTier(tier, argv, (tiered) => tiered);

test("background prefixes the demotion", () => {
  expect(seen("background")).toEqual(backgroundArgv(argv));
});

test("inherit and foreground pass the argv through unprefixed", () => {
  expect(seen("inherit")).toEqual(argv);
  expect(seen("foreground")).toEqual(argv);
});
