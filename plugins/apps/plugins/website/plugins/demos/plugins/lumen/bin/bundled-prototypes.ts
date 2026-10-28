import type { PrototypeFixtureData } from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";

/**
 * The demo's prototypes as the worker has them: `../data/` inlined into the
 * host bundle by the bundler that builds it (vite rewrites `import.meta.glob`
 * wherever it is written) — the seed tree as text, the thumbnails as base64
 * data URLs. Inside a function, not at module scope: Bun has no
 * `import.meta.glob`, and the boot test reads the same folder off disk instead
 * (`./browser-host.test.ts`, through `apps/prototypes/fixtures`'s
 * `readPrototypeFixtureDir`). Empty is a bundler that stopped expanding
 * the globs, never a demo with no prototypes: loud.
 */
export function bundledDemoPrototypes(): PrototypeFixtureData {
  const files = import.meta.glob<string>("../data/prototypes/**/*", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const pngs = import.meta.glob<string>("../data/thumbnails/*.png", {
    query: "?inline",
    import: "default",
    eager: true,
  });
  const tree: Record<string, string> = {};
  for (const [key, text] of Object.entries(files))
    tree[afterPrefix(key, "../data/prototypes/")] = text;
  const thumbnails: Record<string, Uint8Array> = {};
  for (const [key, url] of Object.entries(pngs)) {
    const name = afterPrefix(key, "../data/thumbnails/");
    thumbnails[name.slice(0, -".png".length)] = dataUrlBytes(key, url);
  }
  if (Object.keys(tree).length === 0 || Object.keys(thumbnails).length === 0)
    throw new Error(
      "[demo seed] the host bundle holds no demo prototypes or thumbnails — import.meta.glob was not expanded",
    );
  return { tree, thumbnails };
}

function afterPrefix(key: string, prefix: string): string {
  if (!key.startsWith(prefix))
    throw new Error(`[demo seed] unexpected bundle key "${key}"`);
  return key.slice(prefix.length);
}

const DATA_URL_RE = /^data:image\/png;base64,(.*)$/;

function dataUrlBytes(key: string, url: string): Uint8Array {
  const base64 = DATA_URL_RE.exec(url)?.[1];
  if (base64 === undefined)
    throw new Error(
      `[demo seed] ${key} was not inlined as a PNG data URL (got ${url.slice(0, 40)}…)`,
    );
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
