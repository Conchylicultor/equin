import { describe, expect, test } from "bun:test";
import { backgroundWorkWaiver, BACKGROUND_WORK_WHEN } from "./stop-waiver";

const counts = (byId: Record<string, number | null>) =>
  backgroundWorkWaiver((id) => Promise.resolve(byId[id] ?? null));

describe("backgroundWorkWaiver", () => {
  test("background work running: the stop is waived (the agent waits by stopping)", async () => {
    const reason = await counts({ "conv-a": 1 }).waives("conv-a");
    expect(reason).toContain("1 background task still running");
  });

  test("several tasks: waived, counted", async () => {
    expect(await counts({ "conv-a": 3 }).waives("conv-a")).toContain(
      "3 background tasks still running",
    );
  });

  test("nothing pending: not waived, so a blocking gate still blocks", async () => {
    expect(await counts({ "conv-a": 0 }).waives("conv-a")).toBeNull();
  });

  test("not an sdk agent: not waived", async () => {
    expect(await counts({}).waives("conv-x")).toBeNull();
  });

  test("names the legal way to wait", () => {
    expect(counts({}).when).toBe(BACKGROUND_WORK_WHEN);
    expect(BACKGROUND_WORK_WHEN).toContain("run_in_background: true");
  });
});
