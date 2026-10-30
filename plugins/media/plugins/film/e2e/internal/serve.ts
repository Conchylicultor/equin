// How the film page gets its bytes: everything is answered by Playwright route
// interception on a private origin (`http://film.localhost`) — the stage HTML,
// the renderer bundle, the composition JSON, the assets dir and Inter. No
// server, no socket, no network: the page is same-origin with its assets
// (so images decode untainted and fonts load), and what it sees depends only
// on the composition and the files.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import type { Page } from "playwright";
import { bundlePageScript } from "./bundle";
import type { Composition } from "./composition";
import { SAMPLE_PREFIX } from "./page/sfx";

export const FILM_ORIGIN = "http://film.localhost";
export const STAGE_URL = `${FILM_ORIGIN}/__film/stage.html`;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".css": "text/css",
  ".wav": "audio/wav",
};

const STAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/__film/fonts/inter/index.css">
<style>html,body{margin:0;background:#000;overflow:hidden}</style>
</head><body><script src="/__film/renderer.js"></script></body></html>`;

function interDir(): string {
  return dirname(
    Bun.resolveSync("@fontsource-variable/inter/package.json", import.meta.dir),
  );
}

/** A file under `root`, or null for a path that escapes it or does not exist. */
function under(root: string, rel: string): string | null {
  const p = normalize(join(root, rel));
  if (!p.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return existsSync(p) ? p : null;
}

/**
 * Route the film origin on `page` to `comp` and its files. Call before
 * `page.goto(STAGE_URL)`. `samples`: recorded sounds the SFX synth plays, by
 * the name it fetches them under (`SAMPLE_PREFIX` + name) → absolute path.
 */
export async function serveFilm(
  page: Page,
  comp: Composition,
  samples: Record<string, string> = {},
): Promise<void> {
  const renderer = await bundlePageScript("main.ts");
  const json = JSON.stringify(comp);
  const fonts = interDir();
  const assets = comp.assets.dir;
  await page.route(`${FILM_ORIGIN}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const send = (body: string | Buffer, contentType: string): Promise<void> =>
      route.fulfill({
        status: 200,
        body,
        contentType,
        headers: { "cache-control": "no-store" },
      });
    if (path === "/__film/stage.html")
      return send(STAGE_HTML, "text/html; charset=utf-8");
    if (path === "/__film/renderer.js")
      return send(renderer, "text/javascript; charset=utf-8");
    if (path === "/__film/composition.json")
      return send(json, "application/json");
    const sample = path.startsWith(SAMPLE_PREFIX)
      ? samples[path.slice(SAMPLE_PREFIX.length)]
      : undefined;
    if (sample !== undefined) return send(readFileSync(sample), "audio/wav");
    const file = path.startsWith("/__film/assets/")
      ? under(assets, path.slice("/__film/assets/".length))
      : path.startsWith("/__film/fonts/inter/")
        ? under(fonts, path.slice("/__film/fonts/inter/".length))
        : null;
    if (file === null)
      return route.fulfill({ status: 404, body: `film: nothing at ${path}` });
    return send(
      readFileSync(file),
      MIME[extname(basename(file)).toLowerCase()] ?? "application/octet-stream",
    );
  });
}
