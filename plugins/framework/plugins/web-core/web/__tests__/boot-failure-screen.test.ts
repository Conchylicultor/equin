// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

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

const PAGE_MAP = '{"imports":{"zod":"/artifacts/set.old/zod.js"}}';

function shellWith(importMap: string | null): string {
  const map =
    importMap === null ? "" : `<script type="importmap">${importMap}</script>`;
  return `<!doctype html><html><head>${map}</head><body></body></html>`;
}

/** The shell the server answers now, and every POST /api/reports. */
function serve(importMap: string | null): {
  reports: () => unknown[];
  fetchMock: Mock;
} {
  const fetchMock = vi.fn((url: string, _init?: { body?: string }) =>
    Promise.resolve(
      new Response(url === "/api/reports" ? "{}" : shellWith(importMap)),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    reports: () =>
      fetchMock.mock.calls
        .filter(([url]) => url === "/api/reports")
        .map(([, init]) => JSON.parse(init!.body!) as unknown),
  };
}

/** Lets the shell re-fetch and its comparison settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("boot-failure screen", () => {
  let reload: Mock;
  beforeEach(() => {
    document.head.innerHTML = `<script type="importmap">${PAGE_MAP}</script>`;
    document.body.innerHTML = '<div id="root"></div>';
    reload = vi.fn();
    vi.stubGlobal("location", { href: "http://x/home", reload });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: "http://x/artifacts/a.web.1/index.js", responseStatus: 404 },
      { name: "http://x/artifacts/b.web.2/index.js", responseStatus: 200 },
    ] as unknown as PerformanceEntryList);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is present in the shell", () => {
    expect(source).toBeTruthy();
  });

  it("names the 404ing modules and reports when the served build is this page's", async () => {
    const { reports } = serve(PAGE_MAP);
    new Function(source!)();
    moduleScript().dispatchEvent(new Event("error"));
    await settle();
    const screen = document.getElementById("boot-failure-screen");
    expect(screen?.textContent).toContain("./equin build");
    expect(screen?.textContent).toContain("/artifacts/a.web.1/index.js");
    expect(screen?.textContent).not.toContain("b.web.2");
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({
      kind: "crash",
      source: "plugin-load",
    });
    expect(reload).not.toHaveBeenCalled();
  });

  // A tab holding the shell of a release since replaced: its files are gone,
  // the server serves another build — boot that one, nothing is broken.
  it("reloads into the served build when the page's build is no longer served", async () => {
    const { reports, fetchMock } = serve(
      '{"imports":{"zod":"/artifacts/set.new/zod.js"}}',
    );
    new Function(source!)();
    moduleScript().dispatchEvent(new Event("error"));
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("http://x/home", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.getElementById("boot-failure-screen")).toBeNull();
    expect(reports()).toHaveLength(0);
  });

  it("shows the screen when the served shell cannot be fetched", async () => {
    const fetchMock = vi.fn((url: string) =>
      url === "/api/reports"
        ? Promise.resolve(new Response("{}"))
        : Promise.reject(new TypeError("offline")),
    );
    vi.stubGlobal("fetch", fetchMock);
    new Function(source!)();
    moduleScript().dispatchEvent(new Event("error"));
    await settle();
    expect(document.getElementById("boot-failure-screen")).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows the screen when the global stylesheet fails", async () => {
    const { reports } = serve(PAGE_MAP);
    new Function(source!)();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/style-abc.css";
    document.head.appendChild(link);
    link.dispatchEvent(new Event("error"));
    await settle();
    const screen = document.getElementById("boot-failure-screen");
    // Visible even while the page is hidden waiting for that stylesheet.
    expect(screen?.style.visibility).toBe("visible");
    expect(reports()).toHaveLength(1);
  });

  it("ignores errors of non-module elements", async () => {
    const { fetchMock } = serve(PAGE_MAP);
    new Function(source!)();
    const img = document.createElement("img");
    document.body.appendChild(img);
    img.dispatchEvent(new Event("error"));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById("boot-failure-screen")).toBeNull();
  });
});
