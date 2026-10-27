// Compose step: turn the artifact fleet into a servable dist — the inline
// import map, index.html (preserving web-core's two inline pre-React scripts),
// symlinks into the shared store (or real copies, under `materialize`), the
// eager-tier modulepreload closure, and the hard-fail URL/coverage verification.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildImportMap,
  findUnmappedSpecifiers,
  type ImportMapEntry,
} from "../import-map";
import { sha256Hex } from "../hash";
import { COMMIT_GLOBAL, GRAPH_GLOBAL } from "./vite-builder";

export interface ComposeOptions {
  stagingDir: string;
  /** web-core/web dir (index.html + public/). */
  webSrcDir: string;
  /** The run that produced this dist — recorded in the manifest, never served. */
  buildId: string;
  /**
   * The commit this dist was composed FROM, baked into index.html so the served
   * bundle can name its own tree. `null` when git could not answer — an unknown
   * commit reads as unknown, never as a plausible-looking sha.
   */
  buildCommit: string | null;
  /** Recorded in the marker so map-in-sync recomputes with the dist's own flag. */
  minify: boolean;
  cssHref: string;
  /** dist/artifacts/<linkName> → store dir symlinks. */
  links: Array<{ linkName: string; storePath: string }>;
  /**
   * COPY each store dir into `dist/artifacts/<linkName>` instead of symlinking
   * it, making the dist self-contained (no reference to
   * `~/.equin/cache/web-artifacts/` survives). Vendor sets ride the same `links`
   * array, so they are covered too.
   *
   * For the RELEASE path only — its dist is copied into a shippable bundle, and
   * a symlink into this host's store either ships dangling or, if the copier
   * dereferenced, races the store: a release writes its dist in phase 1 (a
   * `build --hermetic` child that drops `.build.lock` on exit) and copies it in
   * phase 3, and in that unlocked window a concurrent build's `pruneStore()` can
   * unlink the very artifact dirs the links point at. Materializing at
   * composition time closes the window instead of narrowing it: the produced
   * tree never referenced the store at all.
   *
   * Served dists (every `build` target) leave this off — the symlinks are
   * the whole point of the shared content-addressed store there.
   */
  materialize?: boolean;
  /** The full import map (web + core + vendors + registry alias). */
  mapEntries: ImportMapEntry[];
  /** url → emitted STATIC import specifiers (bare or relative) — preload BFS. */
  staticImportsByUrl: Record<string, string[]>;
  /** importer-annotated emitted specifiers (static + dynamic) — coverage check. */
  emitted: Array<{ importer: string; specifiers: string[] }>;
  entryUrl: string;
  /** Seed URLs for the modulepreload closure (entry + registry + eager tier). */
  preloadSeeds: string[];
}

const MAIN_SCRIPT_TAG = '<script type="module" src="/main.tsx"></script>';

/**
 * BFS over static imports from the seed URLs: bare specifiers resolve through
 * the import map; relative specifiers resolve against the importing file's URL.
 * Returns every reachable module URL — the modulepreload set.
 */
export function computePreloadClosure(opts: {
  seeds: string[];
  imports: Record<string, string[]>; // url → emitted static import specifiers
  map: Record<string, string>; // specifier → url
}): string[] {
  const seen = new Set<string>();
  const queue = [...opts.seeds];
  while (queue.length > 0) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    for (const spec of opts.imports[url] ?? []) {
      let next: string | undefined;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        next = new URL(spec, `https://x${url}`).pathname;
      } else {
        next = opts.map[spec];
      }
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

/**
 * The CONTENT identity of everything a loaded tab is frozen on — a pure function
 * of the shell it booted from and the module graph that shell wires up:
 *
 * - `shell` — the SOURCE `index.html`, whose head carries executable inline
 *   scripts (the theme replay, the DevTools hook). Those run once at load and
 *   live in the tab from then on, so editing one changes the served bytes with
 *   no effect on any URL. Hashed as its own tagged line; without it a tab could
 *   hold a genuinely different bundle and still read as fresh.
 * - `entry` / `css` / `map` / `preload` — the module graph. Every value is
 *   already content-addressed, so a code change moves a URL and therefore the
 *   digest.
 *
 * NOT covered, deliberately: the `public/` static files copied verbatim beside
 * index.html (icons, manifest). They are served bytes but nothing freezes them
 * into a running tab — the browser refetches them by URL under its own cache
 * rules — so an icon edit would cost every open tab a reload and buy nothing.
 * If a `public/` file ever becomes something the tab executes at boot, it joins
 * the `shell` line and this paragraph is wrong.
 *
 * Also NOT the COMPOSED html: the commit injected into it moves with the tree
 * even when the graph does not, and hashing the output would reintroduce exactly
 * the per-build churn this replaced — the run-id nonce that made two byte-
 * identical deploys look like different bundles.
 *
 * Entries are tagged and key-sorted so neither object-literal order nor a
 * URL that happens to look like a tag can shift the digest. 16 hex chars, the
 * same width the store uses for an artifact's address.
 */
export function computeGraphHash(graph: {
  /** The SOURCE index.html, verbatim — never the composed output. */
  htmlSrc: string;
  importMap: { imports: Record<string, string> };
  preloads: string[];
  entryUrl: string;
  cssHref: string;
}): string {
  const lines = [
    `shell\t${sha256Hex(graph.htmlSrc)}`,
    `entry\t${graph.entryUrl}`,
    `css\t${graph.cssHref}`,
    ...Object.keys(graph.importMap.imports)
      .sort()
      .map((spec) => `map\t${spec}\t${graph.importMap.imports[spec]}`),
    ...[...graph.preloads].sort().map((url) => `preload\t${url}`),
  ];
  return sha256Hex(lines.join("\n") + "\n").slice(0, 16);
}

export function composeDist(opts: ComposeOptions): {
  importMap: { imports: Record<string, string> };
  preloads: string[];
  /** Content identity of the composed graph — see {@link computeGraphHash}. */
  graphHash: string;
} {
  const { stagingDir } = opts;
  mkdirSync(stagingDir, { recursive: true });

  // 1. Static shell files (icons, …) from web-core's public/.
  const publicDir = join(opts.webSrcDir, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, stagingDir, { recursive: true });
  }

  // 2. Import map + coverage verification: every emitted external specifier of
  // every artifact must resolve in the map — a miss would surface at runtime as
  // the SPA fallback serving index.html for a module URL.
  const importMap = buildImportMap(opts.mapEntries);
  const unmapped = findUnmappedSpecifiers(opts.emitted, importMap);
  if (unmapped.length > 0) {
    const lines = unmapped.map(
      (u) => `  ${u.specifier}  (imported by ${u.importer})`,
    );
    throw new Error(
      `compose: ${unmapped.length} emitted import(s) have no import-map entry:\n${lines.join("\n")}`,
    );
  }

  // 3. Symlink artifacts from the shared store — or copy them, when the dist
  // must outlive the store it was composed from (see `materialize`).
  const artifactsDir = join(stagingDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const link of opts.links) {
    const dest = join(artifactsDir, link.linkName);
    if (opts.materialize) {
      cpSync(link.storePath, dest, { recursive: true });
    } else {
      symlinkSync(link.storePath, dest);
    }
  }

  // 4. Modulepreload closure for the eager tier.
  const preloads = computePreloadClosure({
    seeds: opts.preloadSeeds,
    imports: opts.staticImportsByUrl,
    map: importMap.imports,
  });

  // 5. index.html: keep the source head (theme replay + DevTools-hook inline
  // scripts, icons, title), inject the two bundle pins + import map + global CSS
  // + preloads, and swap the /main.tsx module script for the entry artifact.
  //
  // Read BEFORE the graph hash, which covers the source shell: its inline
  // scripts are code the tab runs and keeps, and they belong to no URL, so
  // nothing else in the digest would move when one of them changes.
  const htmlSrc = readFileSync(join(opts.webSrcDir, "index.html"), "utf8");
  const graphHash = computeGraphHash({
    htmlSrc,
    importMap,
    preloads,
    entryUrl: opts.entryUrl,
    cssHref: opts.cssHref,
  });
  if (!htmlSrc.includes(MAIN_SCRIPT_TAG)) {
    throw new Error(
      `compose: ${MAIN_SCRIPT_TAG} not found in web-core index.html`,
    );
  }
  if (!htmlSrc.includes("</head>")) {
    throw new Error("compose: </head> not found in web-core index.html");
  }
  const headInject = [
    // `var` in a classic script creates a global binding module code can read —
    // artifacts compile `import.meta.env.VITE_BUILD_GRAPH` / `VITE_BUILD_COMMIT`
    // to these identifiers. An unresolvable commit is injected as "" rather than
    // omitted, so the global always exists and reads as "unknown" instead of
    // throwing at a consumer that expected it.
    `<script>var ${GRAPH_GLOBAL} = ${JSON.stringify(graphHash)}; window.${GRAPH_GLOBAL} = ${GRAPH_GLOBAL};` +
      ` var ${COMMIT_GLOBAL} = ${JSON.stringify(opts.buildCommit ?? "")}; window.${COMMIT_GLOBAL} = ${COMMIT_GLOBAL};</script>`,
    `<script type="importmap">${JSON.stringify(importMap)}</script>`,
    `<link rel="stylesheet" href="${opts.cssHref}" />`,
    ...preloads.map((p) => `<link rel="modulepreload" href="${p}" />`),
  ]
    .map((l) => `    ${l}`)
    .join("\n");
  const html = htmlSrc
    .replace("</head>", `${headInject}\n  </head>`)
    .replace(
      MAIN_SCRIPT_TAG,
      `<script type="module" src="${opts.entryUrl}"></script>`,
    );
  writeFileSync(join(stagingDir, "index.html"), html);

  // 6. HARD verification: every URL the page will request must resolve to a
  // real file through the staged tree (following the store symlinks).
  const urls = new Set<string>([
    ...Object.values(importMap.imports),
    ...preloads,
    opts.entryUrl,
    opts.cssHref,
  ]);
  const missing: string[] = [];
  for (const url of urls) {
    const file = join(stagingDir, url.replace(/^\//, ""));
    if (!existsSync(file) || !statSync(file).isFile()) missing.push(url);
  }
  if (missing.length > 0) {
    throw new Error(
      `compose: ${missing.length} mapped URL(s) do not resolve to a real file:\n${missing
        .map((m) => `  ${m}`)
        .join("\n")}`,
    );
  }

  // 7. Manifest — doubles as the marker the web-artifacts checks detect a
  // composed dist by; its absence means nothing was ever composed here.
  writeFileSync(
    join(stagingDir, ".web-artifacts.json"),
    JSON.stringify(
      {
        buildId: opts.buildId,
        graph: graphHash,
        commit: opts.buildCommit,
        minify: opts.minify,
        linkCount: opts.links.length,
        preloadCount: preloads.length,
        importMap,
      },
      null,
      2,
    ),
  );

  return { importMap, preloads, graphHash };
}
