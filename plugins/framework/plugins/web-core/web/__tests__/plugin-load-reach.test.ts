import { afterEach, describe, expect, test, vi } from "vitest";
import { loadPlugins } from "@plugins/framework/plugins/web-sdk/core";

// A chunk the browser dropped while the page was hidden / offline / leaving is
// loaded again once the page is back (web-sdk's page-reach); one that failed
// while the page kept its reach fails at once, as before.

let visibility: DocumentVisibilityState = "visible";
vi.spyOn(document, "visibilityState", "get").mockImplementation(
  () => visibility,
);

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const lost = () => new TypeError("Failed to fetch dynamically imported module");

afterEach(() => {
  setVisibility("visible");
});

describe("loadPlugins across a loss of reach", () => {
  test("a failure while the page stayed visible and online fails at once", async () => {
    const loader = vi.fn(() => Promise.reject(lost()));
    const { plugins, errors } = await loadPlugins([
      { pluginPath: "a", id: "a", loader },
    ]);
    expect(plugins).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test("a failure after the tab was hidden is loaded again once it is visible", async () => {
    let calls = 0;
    const loader = vi.fn(() => {
      calls++;
      if (calls === 1) {
        // The phone backgrounds the browser mid-download.
        setVisibility("hidden");
        return Promise.reject(lost());
      }
      return Promise.resolve({ default: { description: "a" } });
    });
    const result = loadPlugins([{ pluginPath: "a", id: "a", loader }]);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    // Still hidden: nothing asked again, nothing failed.
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    const { plugins, errors } = await result;
    expect(errors).toHaveLength(0);
    expect(plugins).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("a load that fails again with the page back is a failure", async () => {
    let calls = 0;
    const loader = vi.fn(() => {
      calls++;
      if (calls === 1) setVisibility("hidden");
      return Promise.reject(new SyntaxError("Unexpected token"));
    });
    const result = loadPlugins([{ pluginPath: "a", id: "a", loader }]);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    setVisibility("visible");
    const { errors } = await result;
    expect(errors).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
