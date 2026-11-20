// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_HIDDEN_GLOBAL } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";

// The page-shown record lives inline in index.html (it must run before any
// module), so the test lifts it out of the shell and runs it.
const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
const source = /<script id="page-shown">([\s\S]*?)<\/script>/.exec(html)?.[1];

let state: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => state,
});

function setState(next: DocumentVisibilityState): void {
  state = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const recorded = (): unknown => Reflect.get(window, FIRST_HIDDEN_GLOBAL);

describe("the shell's page-shown record", () => {
  afterEach(() => {
    state = "visible";
    Reflect.deleteProperty(window, FIRST_HIDDEN_GLOBAL);
  });

  it("spells boot-trace's global", () => {
    expect(source).toContain(FIRST_HIDDEN_GLOBAL);
  });

  it("records nothing while the page stays visible", () => {
    new Function(source!)();
    expect(recorded()).toBeUndefined();
  });

  it("records the first hide only", () => {
    new Function(source!)();
    setState("hidden");
    const first = recorded();
    expect(typeof first).toBe("number");
    setState("visible");
    setState("hidden");
    expect(recorded()).toBe(first);
  });

  it("records a page already hidden when the head parses", () => {
    state = "hidden";
    new Function(source!)();
    expect(typeof recorded()).toBe("number");
  });
});
