import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * The installed Agent SDK's version and the Claude Code version it was built
 * against (its package.json `claudeCodeVersion`; SDK 0.3.N ↔ CLI 2.1.N). The
 * sdk runtime runs the SYSTEM `claude` instead of the SDK's bundled copy, so
 * the two can drift: the health report flags a different major.minor. Read off
 * the installed package — derived, so an SDK upgrade can never leave a stale
 * copy of it behind.
 */
export const sdkBundledCli = liveValue("runtime-sdk.bundled-cli", {
  schema: z.object({ sdkVersion: z.string(), cliVersion: z.string() }),
});

/** Whether two `X.Y.Z` versions share their major and minor. */
export function sameMajorMinor(a: string, b: string): boolean {
  const mm = (v: string) => v.split(".").slice(0, 2).join(".");
  return mm(a) === mm(b);
}
