import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  INSTALL_ESTIMATES,
  findEstimatesBlock,
  renderEstimatesBlock,
} from "@plugins/installer/core";

const check: Check = {
  id: "estimates-in-sync",
  inputKeyed: true,
  description:
    "install.sh's estimates block is exactly the one generated from plugins/installer/core/estimates.json",
  async run() {
    const root = await getWorktreeRoot();
    const script = await readFile(join(root, "install.sh"), "utf8");
    const found = findEstimatesBlock(script);
    if (!found.ok)
      return {
        ok: false,
        message: found.error,
        hint: "Run `./equin installer estimates --from-json` to write the block back.",
      };
    const want = renderEstimatesBlock(INSTALL_ESTIMATES);
    if (found.text === want) return { ok: true };
    return {
      ok: false,
      message:
        "install.sh's estimates block differs from plugins/installer/core/estimates.json — the window and the terminal would show other times than the measured ones",
      hint: "Never edit either by hand: `./equin installer estimates` regenerates both from the installs' timing files (`--from-json` rewrites only install.sh's block from the JSON).",
    };
  },
};

export default check;
