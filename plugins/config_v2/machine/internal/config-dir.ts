import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { configDir } from "../../data-dirs";

/**
 * This namespace's subtree of the declared user-config directory — the root of
 * the desktop's user-layer store.
 *
 * Resolved at MODULE EVAL, which is why `bin/index.ts` declares the runtime
 * namespace in its very first statement: without one this throws. Only the
 * machine half (and the machine halves that read the config dir) reach it — the
 * portable registry every `ConfigV2` importer loads names no directory.
 */
export const CONFIG_DIR = configDir.file(runtimeNamespace());
