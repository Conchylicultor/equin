import { getConfig } from "@plugins/config_v2/server";
import { duressConfig } from "../../core";

/**
 * The live duress config, read from the registry this plugin registers it in.
 * The shed engine (`plugins/shed`) reads it per admit through here, so its
 * import of this barrel is the edge that ships the registration with it in
 * every composition — a `core` import alone draws none.
 */
export function readDuressConfig() {
  return getConfig(duressConfig);
}
