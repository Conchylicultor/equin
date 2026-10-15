import { test, expect } from "bun:test";
import { dlopen } from "bun:ffi";
import {
  readDarwinBackground,
  withForegroundPriority,
} from "./darwin-background";

// Real kernel state, not a mock: the whole point of this module is that the
// obvious calls LIE (`setpriority(…, 1)` and `taskpolicy -B -p` both report
// success and change nothing), so only the process's own read is evidence.
// The test puts ITSELF into darwinbg first, so it asserts the same transition
// whether the runner started in the foreground or inside an agent session.

const isDarwin = process.platform === "darwin";
const PRIO_DARWIN_PROCESS = 4;
const PRIO_DARWIN_BG = 0x1000;

function setSelfDarwinBg(background: boolean): void {
  const { symbols, close } = dlopen("libSystem.dylib", {
    setpriority: { args: ["i32", "u32", "i32"], returns: "i32" },
  });
  try {
    symbols.setpriority(
      PRIO_DARWIN_PROCESS,
      0,
      background ? PRIO_DARWIN_BG : 0,
    );
  } finally {
    close();
  }
}

test.skipIf(!isDarwin)(
  "withForegroundPriority leaves darwinbg for fn and restores it after",
  async () => {
    const before = readDarwinBackground();
    setSelfDarwinBg(true);
    try {
      expect(readDarwinBackground()).toEqual({ kind: "darwinbg" });
      const inside = await withForegroundPriority(async () =>
        readDarwinBackground(),
      );
      expect(inside).toEqual({ kind: "foreground" });
      expect(readDarwinBackground()).toEqual({ kind: "darwinbg" });
    } finally {
      setSelfDarwinBg(before.kind === "darwinbg");
    }
  },
);

test.skipIf(!isDarwin)(
  "a child spawned inside withForegroundPriority starts in the foreground",
  async () => {
    const before = readDarwinBackground();
    setSelfDarwinBg(true);
    const probe = `
      const { dlopen } = require("bun:ffi");
      const { symbols } = dlopen("libSystem.dylib", { getpriority: { args: ["i32", "u32"], returns: "i32" } });
      process.stdout.write(String(symbols.getpriority(${PRIO_DARWIN_PROCESS}, 0)));
    `;
    // Bun.spawnSync: no stream to race (spawn-safety bans only async Bun.spawn).
    const childState = () =>
      Bun.spawnSync([process.execPath, "-e", probe]).stdout.toString();
    try {
      expect(childState()).toBe("1");
      expect(await withForegroundPriority(async () => childState())).toBe("0");
    } finally {
      setSelfDarwinBg(before.kind === "darwinbg");
    }
  },
);

test.skipIf(!isDarwin)(
  "an already-foreground process runs fn untouched",
  async () => {
    const before = readDarwinBackground();
    setSelfDarwinBg(false);
    try {
      expect(
        await withForegroundPriority(async () => readDarwinBackground()),
      ).toEqual({ kind: "foreground" });
      expect(readDarwinBackground()).toEqual({ kind: "foreground" });
    } finally {
      setSelfDarwinBg(before.kind === "darwinbg");
    }
  },
);
