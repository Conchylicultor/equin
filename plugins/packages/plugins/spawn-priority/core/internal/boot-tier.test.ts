import { test, expect } from "bun:test";
import { dlopen } from "bun:ffi";
import {
  BOOT_TIER_HEADER,
  BOOT_TIERS,
  followGatewayBootTier,
} from "./boot-tier";

// Put THIS process into darwinbg first, so the move is the same transition
// whether the runner started in the foreground or inside an agent session.
function enterDarwinBg(): void {
  if (process.platform !== "darwin") return;
  const { symbols, close } = dlopen("libSystem.dylib", {
    setpriority: { args: ["i32", "u32", "i32"], returns: "i32" },
  });
  try {
    symbols.setpriority(4, 0, 0x1000);
  } finally {
    close();
  }
}

const probe = (tier?: string): Request =>
  new Request("http://backend/api/health/ready", {
    headers: tier === undefined ? {} : { [BOOT_TIER_HEADER]: tier },
  });

// One test, in order: the module remembers that it moved (one way only).
test("followGatewayBootTier leaves darwinbg on the first foreground probe, once", () => {
  enterDarwinBg();
  expect(followGatewayBootTier(probe())).toBeNull();
  expect(followGatewayBootTier(probe(BOOT_TIERS.background))).toBeNull();

  const moved = followGatewayBootTier(probe(BOOT_TIERS.foreground));
  // Read back, never trusted from the write: out of darwinbg where the host
  // has the tier; where it has none, nothing was darwinbg and nothing moved.
  if (process.platform === "darwin") expect(moved?.kind).toBe("foreground");
  else expect(moved).toBeNull();

  expect(followGatewayBootTier(probe(BOOT_TIERS.foreground))).toBeNull();
});
