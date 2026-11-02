import { afterAll } from "bun:test";
import { isolateDeclaredHostServices } from "../host-service";

/**
 * Isolate this test file's declared host services: from here on no service is
 * declared (so a graph the suite boots is not asked for the `bun test`
 * preload's desktop providers, and the services the suite declares are its
 * own), and once the file's tests are done the process's declared set comes
 * back exactly as it was — the suite's own services gone, the preload's back
 * for every later suite in the same bun process.
 *
 * Call it at the top of the file, before the suite declares anything. The
 * clear and its restore are one call, so a suite cannot empty the registry
 * without putting it back.
 */
export function isolateHostServices(): void {
  afterAll(isolateDeclaredHostServices());
}
