import { describe, expect, test } from "bun:test";
import { HANG_HELD_MS } from "@plugins/reports/plugins/check-thread-stall/core";
import { createHangJudge, judgeHang, mainThreadOfSample } from "./hang-judge";

describe("judgeHang", () => {
  test("a beat resets the clock: a busy thread that yields is alive", () => {
    const judge = createHangJudge(0, 0, 0);
    // An hour of CPU, but a timer ran in between: never hung.
    expect(judgeHang(judge, 1, 3_600_000, 3_600_000)).toEqual({
      kind: "alive",
    });
    expect(judgeHang(judge, 1, 3_600_000 + 1_000, 3_600_000 + 5_000)).toEqual({
      kind: "silent",
      heldMs: 1_000,
      silentMs: 5_000,
    });
  });

  test("a thread that holds its core without a beat is hung at HANG_HELD_MS", () => {
    const judge = createHangJudge(7, 100, 0);
    expect(
      judgeHang(judge, 7, 100 + HANG_HELD_MS - 1, HANG_HELD_MS),
    ).toMatchObject({
      kind: "silent",
    });
    expect(
      judgeHang(judge, 7, 100 + HANG_HELD_MS, HANG_HELD_MS + 5_000),
    ).toEqual({
      kind: "hung",
      heldMs: HANG_HELD_MS,
      silentMs: HANG_HELD_MS + 5_000,
    });
  });

  test("a starved thread is never hung, however long it goes without a beat", () => {
    // Background priority on a host under duress: an hour without a timer,
    // a tenth of HANG_HELD_MS on a core.
    const judge = createHangJudge(3, 0, 0);
    expect(judgeHang(judge, 3, HANG_HELD_MS / 10, 3_600_000)).toEqual({
      kind: "silent",
      heldMs: HANG_HELD_MS / 10,
      silentMs: 3_600_000,
    });
  });

  test("the held time counts from the beat the watchdog last saw", () => {
    const judge = createHangJudge(0, 0, 0);
    expect(judgeHang(judge, 1, 50_000, 60_000).kind).toBe("alive");
    // 50 s of CPU before that beat do not count toward the next verdict.
    expect(
      judgeHang(judge, 1, 50_000 + HANG_HELD_MS - 1, 60_000 + HANG_HELD_MS)
        .kind,
    ).toBe("silent");
  });
});

// The shape of macOS `sample` output (trimmed from a real capture).
const SAMPLE = `Analysis of sampling bun (pid 74926) every 1 millisecond
Process:         bun [74926]

Call graph:
    2650 Thread_9912   DispatchQueue_1: com.apple.main-thread  (serial)
      2650 start  (in dyld) + 6992  [0x1813e7da4]
        2650 ???  (in bun)  load address 0x100000000 + 0x2a1c  [0x100002a1c]
          2650 ???  (in <unknown binary>)  [0x3e1f00012345]
            2650 ???  (in bun)  load address 0x100000000 + 0x6aae8  [0x10006aae8]
    2650 Thread_9913: Bun Pool 0
      2650 thread_start  (in libsystem_pthread.dylib) + 8  [0x18178e0fc]
        2650 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x181768a0c]

Total number in stack (recursive counted multiple, when >=5):
`;

describe("mainThreadOfSample", () => {
  test("keeps the main thread's tree and nothing of the other threads", () => {
    expect(mainThreadOfSample(SAMPLE, 40)).toEqual([
      "    2650 Thread_9912   DispatchQueue_1: com.apple.main-thread  (serial)",
      "      2650 start  (in dyld) + 6992  [0x1813e7da4]",
      "        2650 ???  (in bun)  load address 0x100000000 + 0x2a1c  [0x100002a1c]",
      "          2650 ???  (in <unknown binary>)  [0x3e1f00012345]",
      "            2650 ???  (in bun)  load address 0x100000000 + 0x6aae8  [0x10006aae8]",
    ]);
  });

  test("cut to its deep end, the header kept", () => {
    const lines = mainThreadOfSample(SAMPLE, 3);
    expect(lines).toEqual([
      "    2650 Thread_9912   DispatchQueue_1: com.apple.main-thread  (serial)",
      "  … 3 outer frames",
      "            2650 ???  (in bun)  load address 0x100000000 + 0x6aae8  [0x10006aae8]",
    ]);
  });

  test("no main thread, nothing", () => {
    expect(mainThreadOfSample("Call graph:\n", 40)).toEqual([]);
  });
});
