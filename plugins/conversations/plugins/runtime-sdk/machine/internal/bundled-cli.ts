import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { serveValue } from "@plugins/network/plugins/live/server";
import { sdkBundledCli } from "../../core";

const SdkPackageSchema = z.object({
  version: z.string(),
  claudeCodeVersion: z.string(),
});

// The package's own manifest, found from its resolved entry (it exports no
// `./package.json`).
function readSdkPackage(): z.infer<typeof SdkPackageSchema> {
  const entry = fileURLToPath(
    import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
  );
  return SdkPackageSchema.parse(
    JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")),
  );
}

export const sdkBundledCliServed = serveValue(sdkBundledCli, {
  source: "external",
  changes: {
    fixed: { reason: "the installed SDK is fixed for the life of the process" },
  },
  loader: () => {
    const pkg = readSdkPackage();
    return { sdkVersion: pkg.version, cliVersion: pkg.claudeCodeVersion };
  },
});
