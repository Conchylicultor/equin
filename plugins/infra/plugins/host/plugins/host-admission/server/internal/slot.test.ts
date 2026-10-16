import { test, expect } from "bun:test";
import { dlopen } from "bun:ffi";
import { readDarwinBackground } from "@plugins/packages/plugins/spawn-priority/core";
import { slotFor } from "./slot";

// Real kernel state, read by the child itself (the only trustworthy read — see
// spawn-priority's darwin-background.ts). The test sets ITS OWN darwinbg state
// first, so it asserts the same thing whether the runner started in the
// foreground or inside a darwinbg agent session.

const isDarwin = process.platform === "darwin";
const PRIO_DARWIN_PROCESS = 4;
const PRIO_DARWIN_BG = 0x1000;
const BOUND = { timeoutMs: 30_000 };

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

// "1" when the child runs darwinbg, "0" in the foreground.
const PROBE = [
  process.execPath,
  "-e",
  `const { dlopen } = require("bun:ffi");
   const { symbols } = dlopen("libSystem.dylib", { getpriority: { args: ["i32", "u32"], returns: "i32" } });
   process.stdout.write(String(symbols.getpriority(${PRIO_DARWIN_PROCESS}, 0)));`,
];

async function withSelfDarwinBg(
  background: boolean,
  body: () => Promise<void>,
): Promise<void> {
  const before = readDarwinBackground();
  setSelfDarwinBg(background);
  try {
    await body();
  } finally {
    setSelfDarwinBg(before.kind === "darwinbg");
  }
}

test.skipIf(!isDarwin)(
  "a foreground pool's slot spawns its child out of darwinbg, unprefixed",
  () =>
    withSelfDarwinBg(true, async () => {
      const r = await slotFor("foreground").spawn(PROBE, BOUND);
      // A `taskpolicy -b` prefix would read 1: the child is not demoted.
      expect(r.stdout).toBe("0");
      expect(readDarwinBackground()).toEqual({ kind: "darwinbg" });
    }),
);

test.skipIf(!isDarwin)("a foreground pool's slot ignores a smuggled tier", () =>
  withSelfDarwinBg(false, async () => {
    const r = await slotFor("foreground").spawn(PROBE, {
      ...BOUND,
      ...({ tier: "background" } as object),
    });
    expect(r.stdout).toBe("0");
  }),
);

test.skipIf(!isDarwin)(
  "an inherit pool's slot spawns as the caller asks, as before",
  () =>
    withSelfDarwinBg(false, async () => {
      const slot = slotFor("inherit");
      expect((await slot.spawn(PROBE, BOUND)).stdout).toBe("0");
      expect(
        (await slot.spawn(PROBE, { ...BOUND, tier: "background" })).stdout,
      ).toBe("1");
      setSelfDarwinBg(true);
      // Inherited from a darwinbg parent: no lift.
      expect((await slot.spawn(PROBE, BOUND)).stdout).toBe("1");
    }),
);
