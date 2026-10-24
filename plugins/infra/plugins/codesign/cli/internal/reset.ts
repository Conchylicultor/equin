import { existsSync, rmSync } from "node:fs";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { localIdentityPaths, machineHost } from "../../deps";

/**
 * `./equin codesign reset` — delete the local identity. Nothing re-signs here:
 * the next gateway build or `./equin start` creates a new identity and signs
 * with it, because `signBinary` sees the binary is no longer signed by it.
 */
const run: CliAction<[], object> = async () => {
  const { dir } = localIdentityPaths(machineHost());
  if (!existsSync(dir)) {
    console.log(`No local identity at ${dir}: nothing to reset.`);
    return;
  }
  rmSync(dir, { recursive: true });
  console.log(
    `Removed the local code-signing identity (${dir}).\n` +
      "The next `./equin start` creates a new one and re-signs the gateway. macOS then treats it as a new app:\n" +
      'it asks again for each permission, and the old "gateway" rows in System Settings → Privacy & Security can be removed by hand.',
  );
};

export default run;
