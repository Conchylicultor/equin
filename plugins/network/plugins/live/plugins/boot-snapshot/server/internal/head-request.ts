import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { DocumentHead } from "@plugins/shell/plugins/document-head/server";
import { bootSnapshot } from "../../core";
import { HEAD_REQUEST_GLOBAL } from "../../shared/head-request";

/**
 * The head script that starts the boot snapshot request at t0. An inline
 * async module: unlike a classic inline script it does not wait for the
 * render-blocking stylesheet above it, and it imports nothing, so it runs as
 * soon as the parser reaches the end of the head — while the modulepreloads
 * listed before it download. The request is the one the boot task would send
 * (`sendEndpointRequest(fetch, bootSnapshot, {})`: a plain same-origin GET, no
 * headers), its path built from the endpoint's contract.
 *
 * The `.catch` only marks the promise handled, so a network failure before the
 * boot task takes it is not an unhandled rejection; the boot task awaits the
 * same promise and so still sees the failure (and blocks boot on it).
 */
export function bootSnapshotHeadScript(): string {
  const path = JSON.stringify(endpointPath(bootSnapshot, {}));
  const name = JSON.stringify(HEAD_REQUEST_GLOBAL);
  return (
    `<script type="module" async>` +
    `const startMs = performance.now();` +
    `const response = fetch(${path});` +
    `response.catch(() => undefined);` +
    `globalThis[${name}] = { response, startMs };` +
    `</script>`
  );
}

/** Every page of the shell boots, and every boot reads the snapshot: the `""` key. */
export const bootSnapshotHead = DocumentHead.Fragment({
  id: "boot-snapshot",
  render: () => Promise.resolve({ "": bootSnapshotHeadScript() }),
  // A constant: nothing changes it while the backend runs.
  subscribe: () => () => undefined,
});
