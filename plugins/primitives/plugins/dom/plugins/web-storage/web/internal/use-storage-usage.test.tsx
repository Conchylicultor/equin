import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { defineStore } from "./store";
import { useStorageUsage } from "./use-storage-usage";

defineStore({
  owner: "test.static-usage",
  label: "Static usage",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.string(),
  pageWide: { reason: "a test owner" },
});

// A static render to HTML (react-dom/server, no DOM, no storage area) reads the
// owners' in-memory counters as they stand: it must not touch the storage area.
describe("useStorageUsage under a server render", () => {
  it("reads a declared owner, nothing loaded from the area", () => {
    function Probe() {
      return (
        <i>
          {useStorageUsage()
            // bun runs every suite in one process: other suites' owners are
            // declared too.
            .filter((u) => u.owner === "test.static-usage")
            .map((u) => `${u.owner}:${String(u.bytes)}`)
            .join(",")}
        </i>
      );
    }
    expect(renderToStaticMarkup(<Probe />)).toBe(
      "<i>test.static-usage:null</i>",
    );
  });
});
