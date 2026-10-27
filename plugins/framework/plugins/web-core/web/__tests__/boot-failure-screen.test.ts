// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The boot-failure script lives inline in index.html (it must run with no
// module graph at all), so the test lifts it out of the shell and runs it.
const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
const source = /<script id="boot-failure">([\s\S]*?)<\/script>/.exec(html)?.[1];

function moduleScript(): HTMLScriptElement {
  const s = document.createElement("script");
  s.type = "module";
  s.src = "/artifacts/web-core.entry.abc/index.js";
  document.body.appendChild(s);
  return s;
}

describe("boot-failure screen", () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: "http://x/artifacts/a.web.1/index.js", responseStatus: 404 },
      { name: "http://x/artifacts/b.web.2/index.js", responseStatus: 200 },
    ] as unknown as PerformanceEntryList);
  });
  afterEach(() => vi.restoreAllMocks());

  it("is present in the shell", () => {
    expect(source).toBeTruthy();
  });

  it("names the 404ing modules and reports when a module script fails", () => {
    new Function(source!)();
    moduleScript().dispatchEvent(new Event("error"));
    const screen = document.getElementById("boot-failure-screen");
    expect(screen?.textContent).toContain("./equin build");
    expect(screen?.textContent).toContain("/artifacts/a.web.1/index.js");
    expect(screen?.textContent).not.toContain("b.web.2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1]
        .body,
    );
    expect(body).toMatchObject({ kind: "crash", source: "plugin-load" });
  });

  it("ignores errors of non-module elements", () => {
    new Function(source!)();
    const img = document.createElement("img");
    document.body.appendChild(img);
    img.dispatchEvent(new Event("error"));
    expect(document.getElementById("boot-failure-screen")).toBeNull();
  });
});
