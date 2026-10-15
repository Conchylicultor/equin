import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { inThisCheckout } from "./exec";
import type { SearchPlaceOptions } from "./options";

const run: CliAction<[string], SearchPlaceOptions> = (query, opts) =>
  inThisCheckout(async () => {
    const { searchPlace } = await import("./search-place");
    await searchPlace(query, opts);
  });

export default run;
