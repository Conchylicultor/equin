// Compose step: turn the artifact fleet into a servable dist — the inline
// import map, index.html (preserving web-core's two inline pre-React scripts),
// symlinks into the shared store (or real copies, under `materialize`), the
// eager-tier modulepreload closure, and the hard-fail URL/coverage verification.

import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  buildImportMap,
  findUnmappedSpecifiers,
  type ImportMapEntry,
} from "../import-map";
import { sha256Hex } from "../hash";
import {
  APP_PRELOADS_FILE,
  type AppPreloads,
} from "@plugins/apps-core/plugins/app-preload/core";
import {
  CENTRAL_BUILD_GLOBAL,
  COMMIT_GLOBAL,
  GRAPH_GLOBAL,
} from "./vite-builder";

export interface ComposeOptions {
  stagingDir: AppPath;
  /** web-core/web dir (index.html + public/). */
  webSrcDir: AppPath;
  /** The run that produced this dist — recorded in the manifest, never served. */
  buildId: string;
  /**
   * The commit this dist was composed FROM, baked into index.html so the served
   * bundle can name its own tree. `null` when git could not answer — an unknown
   * commit reads as unknown, never as a plausible-looking sha.
   */
  buildCommit: string | null;
  /**
   * Central's code build as the tree this dist was composed from holds it
   * (`build/central-build-id`), baked into index.html so the tab names it to
   * central and judges central's values against it. `null` for a dist no
   * central serves (a release) — the tab then reads it as unknown.
   */
  centralBuild: string | null;
  /** Recorded in the marker so map-in-sync recomputes with the dist's own flag. */
  minify: boolean;
  cssHref: string;
  /** dist/artifacts/<linkName> → store dir symlinks. */
  links: Array<{ linkName: string; storePath: AppPath }>;
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
   * phase 3, and in that unlocked window a concurrent build's `pruneWebArtifactCaches()` can
   * unlink the very artifact dirs the links point at. Materializing at
   * composition time closes the window instead of narrowing it: the produced
   * tree never referenced the store at all.
   *
   * Served dists (every `build` target) leave this off — the symlinks are
   * the whole point of the shared content-addressed store there.
   */
  materialize?: boolean;
  /**
   * A SERVED dist's address directory: the one persistent `<name> → store`
   * link dir of its namespace, shared by every release of it. When set, the
   * staged `artifacts` is a symlink to it and compose links into it only the
   * names it does not hold yet — so a release serves every address its
   * namespace recently composed (an open tab keeps loading the build it came
   * from) for O(new names), not O(history), per build. What stays is decided
   * after compose by `cli/`'s address retention. Adding a link never changes
   * what an existing name serves: every name is a write-once content address,
   * so an existing name must already link the same store path (else throws).
   * Exclusive with `materialize` (a release links nothing).
   */
  addressDir?: AppPath;
  /** The full import map (web + core + vendors + registry alias). */
  mapEntries: ImportMapEntry[];
  /** url → emitted STATIC import specifiers (bare or relative) — preload BFS. */
  staticImportsByUrl: Record<string, string[]>;
  /** importer-annotated emitted specifiers (static + dynamic) — coverage check. */
  emitted: Array<{ importer: string; specifiers: string[] }>;
  entryUrl: string;
  /** Seed URLs for the modulepreload closure (entry + registry + eager tier). */
  preloadSeeds: string[];
  /**
   * Per app root (`apps/plugins/<app>/`): the artifact URLs of that app's
   * deferred plugins — seeds of the app's own preload closure, written to the
   * dist's `.app-preloads.json` (`apps-core/app-preload`), which the backend
   * splices into the head of that app's pages.
   */
  appPreloadSeeds: Record<string, string[]>;
}

const MAIN_SCRIPT_TAG = '<script type="module" src="/main.tsx"></script>';

/**
 * Every module URL reachable over static imports from the seed URLs — the
 * modulepreload set — DEPENDENCIES FIRST: a post-order walk from each seed in
 * turn, each module's imports in the order it imports them. Bare specifiers
 * resolve through the import map; relative ones against the importing file's
 * URL.
 *
 * The order is the order the shell lists the preloads, and so roughly the
 * order the browser answers them in (~1,600 of them, drained first-in
 * first-out even from the HTTP cache). A module graph can run only once all
 * of it is in, so listing each module after what it imports completes the
 * entry's own graph first (DOMContentLoaded), then each eager plugin's, and
 * any smaller graph the page starts early (a head script) with it. Sorted by
 * URL, the vendor set (`set.<hash>/`: react, zod — imported by nearly
 * everything) came last: DOMContentLoaded of a warm /demo reload went from
 * about 1,050 to 525 ms with this order (2026-11-10).
 */
export function computePreloadClosure(opts: {
  seeds: string[];
  imports: Record<string, string[]>; // url → emitted static import specifiers
  map: Record<string, string>; // specifier → url
}): string[] {
  const resolve = (from: string, spec: string): string | undefined =>
    spec.startsWith("./") || spec.startsWith("../")
      ? new URL(spec, `https://x${from}`).pathname
      : opts.map[spec];
  const seen = new Set<string>();
  const order: string[] = [];
  // Iterative: a deep import chain must not overflow the stack.
  for (const seed of opts.seeds) {
    if (seen.has(seed)) continue;
    seen.add(seed);
    const stack: { url: string; next: number }[] = [{ url: seed, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const specs = opts.imports[top.url] ?? [];
      if (top.next < specs.length) {
        const dep = resolve(top.url, specs[top.next++]!);
        if (dep !== undefined && !seen.has(dep)) {
          seen.add(dep);
          stack.push({ url: dep, next: 0 });
        }
        continue;
      }
      stack.pop();
      order.push(top.url);
    }
  }
  return order;
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
 * - `pin` — every value compose bakes into the page that a reload changes
 *   (`pagePins`, `identity: "covered"`): the central build the tab names to
 *   central and judges central's values against. A redeploy that changes only
 *   central code changes no URL, yet a reload brings the tab another central
 *   build — so it is a new page, and its tabs are stale.
 *
 * Also NOT the COMPOSED html: the commit injected into it moves with the tree
 * even when the graph does not (`pagePins` says so, `identity: "excluded"`),
 * and hashing the output would reintroduce exactly the per-build churn this
 * replaced — the run-id nonce that made two byte-identical deploys look like
 * different bundles.
 *
 * Entries are tagged and key-sorted so neither object-literal order nor a
 * URL that happens to look like a tag can shift the digest. 16 hex chars, the
 * same width the store uses for an artifact's address.
 */
export function computeGraphHash(graph: {
  /**
   * Every value compose bakes into the page (`pagePins`) — the identity hashes
   * the ones a reload changes (`identity: "covered"`) and skips the rest.
   */
  pins: readonly PagePin[];
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
    ...graph.pins
      .filter((pin) => pin.identity === "covered")
      .map((pin) => `pin\t${pin.global}\t${pin.value}`)
      .sort(),
  ];
  return sha256Hex(lines.join("\n") + "\n").slice(0, 16);
}

/**
 * A value compose bakes into index.html as a global the bundle reads
 * (`import.meta.env.VITE_*`). Each says whether the page's identity covers it —
 * a required choice, so a new pin cannot be baked into the page without
 * deciding whether a tab holding another value of it is stale.
 */
export type PagePin = { global: string; value: string } & (
  | {
      /** A reload changes it: part of the page's identity (`computeGraphHash`). */
      identity: "covered";
    }
  | {
      identity: "excluded";
      /** Why a tab holding another value of it is not stale. */
      reason: string;
    }
);

/** Every global compose bakes into the page beside the graph hash itself. */
export function pagePins(opts: {
  buildCommit: string | null;
  centralBuild: string | null;
}): PagePin[] {
  // An unknown value is baked as "" rather than omitted, so the global always
  // exists and reads as "unknown" instead of throwing at a consumer.
  return [
    {
      global: COMMIT_GLOBAL,
      value: opts.buildCommit ?? "",
      identity: "excluded",
      reason:
        "the tree the graph was built from moves with every commit even when the bytes do not; a rebuild of unchanged code is the same page",
    },
    {
      global: CENTRAL_BUILD_GLOBAL,
      value: opts.centralBuild ?? "",
      identity: "covered",
    },
  ];
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
  const publicDir = joinAppPath(opts.webSrcDir, "public");
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
  const artifactsDir = joinAppPath(stagingDir, "artifacts");
  if (opts.addressDir !== undefined) {
    if (opts.materialize) {
      throw new Error("compose: `addressDir` and `materialize` are exclusive");
    }
    mkdirSync(opts.addressDir, { recursive: true });
    symlinkSync(opts.addressDir, artifactsDir);
  } else {
    mkdirSync(artifactsDir, { recursive: true });
  }
  for (const link of opts.links) {
    const dest = joinAppPath(artifactsDir, link.linkName);
    if (opts.addressDir !== undefined) {
      if (lstatSync(dest, { throwIfNoEntry: false }) === undefined) {
        symlinkSync(link.storePath, dest);
      } else if (readlinkSync(dest) !== link.storePath) {
        throw new Error(
          `compose: ${dest} links ${readlinkSync(dest)}, not ${link.storePath} — ` +
            `an address is write-once, so one name must always name one store path. ` +
            `If the cache root itself moved, delete ${opts.addressDir} and build again ` +
            `(open tabs of this namespace then reload).`,
        );
      }
    } else if (opts.materialize) {
      // A worker tree is a dir of links into the store: copy what they name.
      cpSync(link.storePath, dest, { recursive: true, dereference: true });
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

  // 4b. Per app: the modules its deferred plugins load that the shell does not
  // already preload — what a page of that app needs from t0 besides the shell.
  const shellPreloads = new Set(preloads);
  const appPreloads: AppPreloads = { v: 1, apps: {} };
  for (const [root, seeds] of Object.entries(opts.appPreloadSeeds)) {
    appPreloads.apps[root] = computePreloadClosure({
      seeds,
      imports: opts.staticImportsByUrl,
      map: importMap.imports,
    }).filter((url) => !shellPreloads.has(url));
  }

  // 5. index.html: keep the source head (theme replay + DevTools-hook inline
  // scripts, icons, title), inject the two bundle pins + import map + global CSS
  // + preloads, and swap the /main.tsx module script for the entry artifact.
  //
  // Read BEFORE the graph hash, which covers the source shell: its inline
  // scripts are code the tab runs and keeps, and they belong to no URL, so
  // nothing else in the digest would move when one of them changes.
  const htmlSrc = readFileSync(
    joinAppPath(opts.webSrcDir, "index.html"),
    "utf8",
  );
  const pins = pagePins(opts);
  const graphHash = computeGraphHash({
    htmlSrc,
    pins,
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
    // artifacts compile `import.meta.env.VITE_BUILD_GRAPH` / `VITE_*` to these
    // identifiers. The graph hash, then every pin — the SAME list the hash
    // read, so nothing reaches the page that the identity did not decide on.
    `<script>${[{ global: GRAPH_GLOBAL, value: graphHash }, ...pins]
      .map(
        ({ global, value }) =>
          `var ${global} = ${JSON.stringify(value)}; window.${global} = ${global};`,
      )
      .join(" ")}</script>`,
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
  writeFileSync(joinAppPath(stagingDir, "index.html"), html);
  // The page's central build, beside the page that bakes it: the served dist's
  // `.central-build`, which the backend serving this page names to its tabs
  // (`build/server-build-id` → the ack frames' `central`) — what a reload
  // brings a tab, so it can tell a central value a reload fixes from one no
  // reload can. None when the page names none (a release): unknown.
  if (opts.centralBuild !== null && opts.centralBuild !== "")
    writeFileSync(
      joinAppPath(stagingDir, ".central-build"),
      opts.centralBuild + "\n",
    );

  writeFileSync(
    joinAppPath(stagingDir, APP_PRELOADS_FILE),
    JSON.stringify(appPreloads),
  );

  // 6. HARD verification: every URL the page will request must resolve to a
  // real file through the staged tree (following the store symlinks).
  const urls = new Set<string>([
    ...Object.values(importMap.imports),
    ...preloads,
    ...Object.values(appPreloads.apps).flat(),
    opts.entryUrl,
    opts.cssHref,
  ]);
  const missing: string[] = [];
  for (const url of urls) {
    const file = joinAppPath(stagingDir, url.replace(/^\//, ""));
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
    joinAppPath(stagingDir, ".web-artifacts.json"),
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
