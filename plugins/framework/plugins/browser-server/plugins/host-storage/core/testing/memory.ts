import {
  declareHostStorage,
  memoryHostStorage,
} from "../internal/host-storage";

/**
 * Declare that this process's browser host keeps its state in memory — what a
 * test that boots a browser graph (PGlite and the in-memory host stores)
 * declares before `bootBrowserHost`, as a host's entry point declares its
 * storage. Repeatable: the memory storage is one stateless instance.
 */
export function declareMemoryHostStorage(): void {
  declareHostStorage(memoryHostStorage());
}
