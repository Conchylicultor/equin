import {
  persistedDefinitions,
  persistedKeys,
} from "@plugins/framework/plugins/server-core/core";
import { stampDefinition } from "./code-stamp";
import type { L2Expectation } from "./persist";

/**
 * The running backend's usable-row expectation (see `L2Expectation`): the keys
 * the runtime persists right now and their definitions, read at call time —
 * after the hooks are installed (`persistedKeys()` reads `shouldPersist`
 * through them) and after the deferred resources bound their plans. Each
 * definition is stamped with this process's code (`./code-stamp`), as every
 * persist writes it.
 */
export function l2Expectation(): L2Expectation {
  const definitions: Record<string, string> = {};
  for (const [key, definition] of Object.entries(persistedDefinitions())) {
    const stamped = stampDefinition(definition);
    if (stamped !== null) definitions[key] = stamped;
  }
  return { persisted: persistedKeys(), definitions };
}
