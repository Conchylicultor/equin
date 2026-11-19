/**
 * Every `spawnCaptured` child is metered as one wait (`installSpawnWaitMeter`):
 * under its program's name or the caller's, ended once with what it was for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnCaptured } from "./internal/spawn-captured";
import { installSpawnWaitMeter } from "./internal/spawn-wait";
import type { SpawnWaitDetail } from "./internal/types";

const BOUND = { timeoutMs: 10_000 };

let ended: { layer: string; detail: SpawnWaitDetail | undefined }[] = [];
let begun: string[] = [];

function meter(): void {
  ended = [];
  begun = [];
  installSpawnWaitMeter((layer) => {
    begun.push(layer);
    return (detail) => ended.push({ layer, detail });
  });
}

afterEach(() => installSpawnWaitMeter(null));

describe("spawn wait meter", () => {
  test("a child is a wait named for its program, ended once as it is reaped", async () => {
    meter();
    const r = await spawnCaptured(["/bin/echo", "hi"], BOUND);
    expect(r.stdout).toBe("hi\n");
    expect(begun).toEqual(["spawn:echo"]);
    expect(ended).toEqual([{ layer: "spawn:echo", detail: undefined }]);
  });

  test("the caller names the wait and describes it from the result", async () => {
    meter();
    await spawnCaptured(["/bin/echo", "hi"], {
      ...BOUND,
      wait: {
        layer: "test:echo",
        describe: (r) => ({ variant: r.stdout.trim(), measures: { ids: 1 } }),
      },
    });
    expect(ended).toEqual([
      { layer: "test:echo", detail: { variant: "hi", measures: { ids: 1 } } },
    ]);
  });

  test("a child that fails to start still ends its wait", async () => {
    meter();
    const run = spawnCaptured(["/nonexistent/program"], BOUND);
    expect(run).rejects.toThrow();
    await run.catch((err: unknown) => {
      if (!(err instanceof Error)) throw err;
    });
    expect(ended).toEqual([{ layer: "spawn:program", detail: undefined }]);
  });

  test("a describe that throws still ends the wait", async () => {
    meter();
    const run = spawnCaptured(["/bin/echo", "hi"], {
      ...BOUND,
      wait: {
        layer: "test:echo",
        describe: () => {
          throw new Error("describe failed");
        },
      },
    });
    expect(run).rejects.toThrow("describe failed");
    await run.catch((err: unknown) => {
      if (!(err instanceof Error)) throw err;
    });
    expect(ended).toEqual([{ layer: "test:echo", detail: undefined }]);
  });

  test("a per-process binary name is one layer", async () => {
    meter();
    const run = spawnCaptured(["/nonexistent/equin · kind · 42"], BOUND);
    await run.catch((err: unknown) => {
      if (!(err instanceof Error)) throw err;
    });
    expect(begun).toEqual(["spawn:equin"]);
  });

  test("no meter installed: nothing is metered", async () => {
    begun = [];
    await spawnCaptured(["/bin/echo", "hi"], BOUND);
    expect(begun).toEqual([]);
  });
});
