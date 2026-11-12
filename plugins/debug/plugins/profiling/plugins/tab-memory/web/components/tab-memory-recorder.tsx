import { useEffect } from "react";
import {
  EndpointError,
  fetchEndpointOver,
} from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import {
  submitTabMemorySample,
  TAB_MEMORY_FIRST_SAMPLE_MS,
  TAB_MEMORY_SAMPLE_EVERY_MS,
} from "../../core";
import { takeSample } from "../internal/measure";

// Page-wide telemetry: a page's reading of itself reaches its own server (D3).
const fetchEndpoint = fetchEndpointOver(pageTransport);

async function send(): Promise<void> {
  // Measured outside the try: a bug in the measurement surfaces, never read
  // as a network failure.
  const sample = takeSample();
  try {
    await fetchEndpoint(
      submitTabMemorySample,
      {},
      // A failed observability post is not a user-facing error.
      { body: { sample }, report: false },
    );
  } catch (err) {
    // The server is down or restarting (no response, or a 5xx): drop this
    // reading, the next one carries the page's state (nothing here is
    // additive). A 4xx — the server refusing the sample's shape — is a bug
    // and surfaces, as does anything else.
    const unreachable =
      err instanceof TypeError ||
      (err instanceof EndpointError && err.status >= 500);
    if (!unreachable) throw err;
  }
}

/**
 * Headless (`Core.Root`, one per page): samples the page's own memory once it
 * has settled, then every few minutes for as long as it lives. A timer, not a
 * subscription: a page's memory has no change signal. An embedded document
 * (an iframe of the app) samples nothing — its memory is its host page's
 * renderer's, and the host page lists what it holds. Nor does a page driven
 * by automation (`navigator.webdriver`: the agent browser, an e2e run): it is
 * not the user's Chrome, and the e2e harness measures its own.
 */
export function TabMemoryRecorder(): null {
  useEffect(() => {
    if (window.top !== window || navigator.webdriver) return;
    let timer = setTimeout(function tick() {
      void send();
      timer = setTimeout(tick, TAB_MEMORY_SAMPLE_EVERY_MS);
    }, TAB_MEMORY_FIRST_SAMPLE_MS);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
