/**
 * The static renderer end to end, on a two-pane fixture app: the path resolves
 * through the static pane store (index and a segment), a navigating control
 * carries its destination as `data-link`, the pane's title comes back, and
 * every failure — the wrong pane, an unknown path, a throwing component, a
 * network read — throws naming the pane and the path.
 *
 * One renderer per process, so one suite: vitest gives this file its own
 * module registry, and nothing else in it reads the render mode.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type {
  LoadedPlugin,
  PluginEntry,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  defineRoute,
  useOpenPane,
  type AnyPane,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  createStaticRenderer,
  StaticRenderError,
  type StaticRenderer,
} from "../internal/static-renderer";
import { StaticRenderNetworkError } from "../internal/static-transport";

const app = defineApp({
  id: "sr-site",
  name: "Static render site",
  basePath: "/site",
  icon: symbol("science"),
});

const aboutPane: AnyPane = Pane.define({
  route: defineRoute({ id: "sr-about", segment: "about" }),
  app,
  title: "About us",
  component: About,
});

const homePane: AnyPane = Pane.define({
  route: defineRoute({ id: "sr-home", segment: "" }),
  app,
  appIndex: true,
  component: Home,
});

const brokenPane: AnyPane = Pane.define({
  route: defineRoute({ id: "sr-broken", segment: "broken" }),
  app,
  component: Broken,
});

const fetchingPane: AnyPane = Pane.define({
  route: defineRoute({ id: "sr-fetching", segment: "fetching" }),
  app,
  component: Fetching,
});

const pendingPane: AnyPane = Pane.define({
  route: defineRoute({ id: "sr-pending", segment: "pending" }),
  app,
  component: Pending,
});

function Home() {
  const openPane = useOpenPane();
  return (
    <main>
      <h1>Welcome</h1>
      <button type="button" {...openPane.link(aboutPane, {}, { mode: "root" })}>
        About
      </button>
    </main>
  );
}

function About() {
  return <p>We make things.</p>;
}

function Broken(): never {
  throw new Error("boom");
}

function Pending() {
  return <Loading label="Loading the notes…" />;
}

function Fetching() {
  // A read during render reaching for the server, its expected rejection
  // handled by the caller: the render must still fail.
  void useTransport()
    .fetch("/api/nothing")
    .catch((err: unknown) => {
      if (!(err instanceof StaticRenderNetworkError)) throw err;
    });
  return <p>fetched</p>;
}

const plugin = {
  description: "static-render test fixture",
  contributions: [
    aboutPane,
    homePane,
    brokenPane,
    fetchingPane,
    pendingPane,
  ].map((pane) => Pane.Register({ pane })),
} as unknown as LoadedPlugin;

const entries: PluginEntry[] = [
  {
    pluginPath: "fixtures/plugins/static-render-site",
    id: "fixtures.static-render-site",
    loader: async () => ({ default: plugin }),
  },
];

let renderer: StaticRenderer;

beforeAll(async () => {
  renderer = await createStaticRenderer({
    entries,
    composition: { id: "sr-site", home: "sr-site" },
    bootSnapshot: { resources: { "sr.unknown-key": 1 }, tuples: {} },
  });
});

describe("createStaticRenderer", () => {
  it("reports snapshot keys no loaded plugin declares", () => {
    expect(renderer.unhydrated).toEqual(["sr.unknown-key"]);
  });

  it("resolves the composition's home app to its base path", () => {
    expect(renderer.home).toEqual({
      id: "sr-site",
      name: "Static render site",
      basePath: "/site",
    });
  });

  it("renders the index pane at the app's base path, links as data-link", async () => {
    const page = await renderer.render({ pane: homePane, path: "/site" });
    expect(page.html).toContain("<h1>Welcome</h1>");
    expect(page.html).toContain('data-link="/site/about"');
    expect(page.html).toContain('data-pane-id="sr-home"');
    expect(page.title).toBeUndefined();
  });

  it("renders a pane at its own segment, with its title", async () => {
    const page = await renderer.render({
      pane: aboutPane,
      path: "/site/about",
    });
    expect(page.html).toContain("<p>We make things.</p>");
    expect(page.title).toBe("About us");
  });

  it("renders by path alone, naming the pane and its app", async () => {
    const page = await renderer.render({ path: "/site/about" });
    expect(page.html).toContain("<p>We make things.</p>");
    expect(page.title).toBe("About us");
    expect(page.paneId).toBe("sr-about");
    expect(page.app.name).toBe("Static render site");
  });

  it("refuses a bare path no registered app holds", async () => {
    await expect(renderer.render({ path: "/elsewhere/about" })).rejects.toThrow(
      /no registered pane's app has a base path holding it/,
    );
  });

  it("refuses a path that resolves to another pane", async () => {
    await expect(
      renderer.render({ pane: aboutPane, path: "/site" }),
    ).rejects.toThrow(
      /pane "sr-about" at \/site: .*resolves to pane "sr-home"/,
    );
  });

  it("refuses a path that resolves to nothing", async () => {
    await expect(
      renderer.render({ pane: aboutPane, path: "/site/nowhere" }),
    ).rejects.toThrow(/resolves to no registered pane/);
  });

  it("refuses a path outside the pane's app", async () => {
    await expect(
      renderer.render({ pane: aboutPane, path: "/elsewhere/about" }),
    ).rejects.toThrow(/not under its app's base path \/site/);
  });

  it("a throwing component fails the render, naming its component path", async () => {
    const err: unknown = await renderer
      .render({ pane: brokenPane, path: "/site/broken" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(StaticRenderError);
    expect((err as Error).message).toContain('pane "sr-broken"');
    expect((err as Error).message).toContain("boom");
    expect((err as StaticRenderError).componentStack).toContain("Broken");
  });

  it("a loading state fails the render, naming the pane and what was loading", async () => {
    const err: unknown = await renderer
      .render({ pane: pendingPane, path: "/site/pending" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(StaticRenderError);
    expect((err as Error).message).toContain('pane "sr-pending"');
    expect((err as Error).message).toContain("Loading the notes…");
    expect((err as StaticRenderError).componentStack).toContain("Pending");
  });

  it("a request made during the render fails it, even when swallowed", async () => {
    await expect(
      renderer.render({ pane: fetchingPane, path: "/site/fetching" }),
    ).rejects.toThrow(/a request was made \(\/api\/nothing\)/);
  });

  it("is once per process", async () => {
    await expect(
      createStaticRenderer({
        entries,
        composition: { id: "sr-site", home: "sr-site" },
        bootSnapshot: { resources: {}, tuples: {} },
      }),
    ).rejects.toThrow(/called twice/);
  });
});
