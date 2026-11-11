import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { inThisCheckout } from "./exec";

const run: CliAction<
  [string | undefined],
  { only?: string; skipCooldown?: boolean }
> = (id, opts) =>
  inThisCheckout(async () => {
    // Loaded after the boot has declared the runtime namespace.
    const { upgrade } = await import("./upgrade-body");
    await upgrade(
      id,
      opts.only?.split(",").map((n) => n.trim()),
      opts.skipCooldown === true ? "skip" : "honour",
    );
  });

export default run;
