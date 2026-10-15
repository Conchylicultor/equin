import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { inThisCheckout } from "./exec";
import type { ImportMapstrOptions } from "./options";

const run: CliAction<[string], ImportMapstrOptions> = (path, opts) =>
  inThisCheckout(async (namespace) => {
    const { importMapstr } = await import("./import");
    await importMapstr(path, opts, namespace);
  });

export default run;
