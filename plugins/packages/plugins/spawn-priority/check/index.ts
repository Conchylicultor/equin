import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own plugin, so relative.
import { BOOT_TIER_HEADER, BOOT_TIERS } from "../core/internal/boot-tier";

const GATEWAY_FILE = "gateway/worktree.go";

/** `<goName> = "<value>"` — a Go string constant's declaration. */
function goConstant(text: string, goName: string): string | undefined {
  return new RegExp(`\\b${goName}\\s*=\\s*"([^"]+)"`).exec(text)?.[1];
}

/**
 * The boot-tier header is written by the gateway (Go) on its readiness probe
 * and read by the booting backend (TypeScript); Go cannot import the
 * TypeScript constant. A drift is silent: the backend never hears it may
 * leave darwinbg, and every demoted boot crawls to its deadline again. Header
 * names compare case-insensitively, values exactly.
 */
const bootTierInSyncCheck: Check = {
  id: "spawn-priority:boot-tier-in-sync",
  description:
    "The gateway's readiness-probe boot-tier header and values (bootTierHeader / bootTierBackground / bootTierForeground in gateway/worktree.go) must be the ones the backend reads (BOOT_TIER_HEADER / BOOT_TIERS)",
  async run() {
    const root = await getWorktreeRoot();
    const text = await readFile(join(root, GATEWAY_FILE), "utf8");
    const pairs: [string, string | undefined, string][] = [
      [
        "bootTierHeader",
        goConstant(text, "bootTierHeader")?.toLowerCase(),
        BOOT_TIER_HEADER.toLowerCase(),
      ],
      [
        "bootTierBackground",
        goConstant(text, "bootTierBackground"),
        BOOT_TIERS.background,
      ],
      [
        "bootTierForeground",
        goConstant(text, "bootTierForeground"),
        BOOT_TIERS.foreground,
      ],
    ];
    for (const [goName, goValue, tsValue] of pairs) {
      if (goValue !== tsValue) {
        return {
          ok: false,
          message:
            goValue === undefined
              ? `${GATEWAY_FILE} declares no \`${goName} = "…"\` constant`
              : `the gateway's ${goName} is "${goValue}" but the backend reads "${tsValue}"`,
          hint: "Make gateway/worktree.go's boot-tier constants and plugins/packages/plugins/spawn-priority/core/internal/boot-tier.ts agree — otherwise a demoted boot never hears it may leave darwinbg.",
        };
      }
    }
    return { ok: true };
  },
};

export default [bootTierInSyncCheck];
