import { expect, test } from "bun:test";
import { injectFrameAgent, installFrameAgent } from "./frame-agent";
import { FRAME_PROTOCOL } from "./protocol";

test("the agent is the first script of <head>", () => {
  const out = injectFrameAgent(
    '<!doctype html><html><head lang="en"><script>mine()</script></head></html>',
  );
  const agent = out.indexOf("installFrameAgent");
  expect(agent).toBeGreaterThan(out.indexOf("<head"));
  expect(agent).toBeLessThan(out.indexOf("mine()"));
  expect(out).toContain(JSON.stringify(FRAME_PROTOCOL));
});

test("a document without <head> gets it after its doctype", () => {
  const out = injectFrameAgent("<!DOCTYPE html><p>hi</p>");
  expect(out.startsWith("<!DOCTYPE html><script>")).toBe(true);
});

test("the agent references nothing outside its own body", () => {
  // Evaluated with no module scope at all: any free reference to a module
  // binding (an import, a top-level const) throws a ReferenceError here.
  const run = new Function(
    "window",
    `return (${installFrameAgent.toString()})(window, "p");`,
  );
  const listeners: string[] = [];
  const fakeWindow = {
    document: {},
    addEventListener: (type: string) => listeners.push(type),
  };
  expect(() => run(fakeWindow)).not.toThrow();
  expect(listeners).toEqual(["message"]);
});
