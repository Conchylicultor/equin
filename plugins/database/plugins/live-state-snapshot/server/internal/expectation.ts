import {
  persistedDefinitions,
  persistedKeys,
} from "@plugins/framework/plugins/server-core/core";
import { stampDefinition } from "./code-stamp";
import type { L2Expectation } from "./persist";

/**
 * The running backend's usable-row expectation (see `L2Expectation`): the keys
 * the runtime persists right now and the stored definition of each, read at
 * call time — after the hooks are installed (`persistedKeys()` reads
 * `shouldPersist` through them) and after the deferred resources bound their
 * plans. Every key's definition (its plan's, or none) is stamped with the
 * code that produces its value (`./code-stamp`), as every persist writes it.
 */
export function l2Expectation(): L2Expectation {
  const planned = persistedDefinitions();
  const persisted = persistedKeys();
  const definitions: Record<string, string> = {};
  for (const key of persisted) {
    definitions[key] = stampDefinition(key, planned[key] ?? null);
  }
  return { persisted, definitions };
}
