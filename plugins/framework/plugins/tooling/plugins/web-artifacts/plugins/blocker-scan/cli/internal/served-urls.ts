// The URLs main serves, read off its dists on disk — never by crawling it.
//
// A served namespace's dist (`<ns>/web`) links into a shared address dir that
// also holds older graphs' names, so what its current page can fetch is the
// served graph's record (`servedGraphOf`, the same list address retention
// keeps): each name is a dir under `/artifacts/`, walked for its files
// (through the store's links; a worker tree is links to other entries). The
// dist's own top-level files (index.html, assets/, icons) are served too. A
// release dist (`<ns>/release-web/<composition>`) is a materialized copy —
// exactly what ships to the public site — so it is walked whole.

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { z } from "zod";
import { servedGraphOf } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/plugins/served-addresses/cli";
import { webGraphRecordsDir } from "@plugins/infra/plugins/paths/core";

/** Precompressed sidecars and sourcemaps: never requested by a page as a URL of their own. */
const NOT_A_PAGE_URL = /\.(br|gz|map)$/;

/** A dist and the URLs it serves. */
export interface ServedDist {
  /** Where it is on disk, for the log. */
  dir: string;
  /** Each served path (`/artifacts/<entry>/core/x.js`) and the file behind it. */
  files: Array<{ path: string; file: string }>;
}

/**
 * Every file under `dir` (symlinks followed), relative to it. Memoized by
 * real path: worker trees link the same entries many times over.
 */
function filesUnder(
  dir: string,
  memo: Map<string, readonly string[]>,
  depth = 0,
): readonly string[] {
  const real = realpathSync(dir);
  const hit = memo.get(real);
  if (hit !== undefined) return hit;
  if (depth > 16) {
    throw new Error(`${dir}: more than 16 directories deep — a link cycle?`);
  }
  const out: string[] = [];
  for (const name of readdirSync(real)) {
    const child = join(real, name);
    let st;
    try {
      st = statSync(child);
    } catch (err) {
      // A dangling link: nothing is served at that name.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (st.isDirectory()) {
      for (const f of filesUnder(child, memo, depth + 1))
        out.push(`${name}/${f}`);
    } else if (!NOT_A_PAGE_URL.test(name)) {
      out.push(name);
    }
  }
  memo.set(real, out);
  return out;
}

function walk(
  root: string,
  rel: string,
  memo: Map<string, readonly string[]>,
  into: ServedDist["files"],
): void {
  const abs = rel === "" ? root : join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // pruned since the record
    throw err;
  }
  if (!st.isDirectory()) {
    if (!NOT_A_PAGE_URL.test(abs)) into.push({ path: `/${rel}`, file: abs });
    return;
  }
  for (const f of filesUnder(abs, memo)) {
    const path = rel === "" ? f : `${rel}/${f}`;
    into.push({ path: `/${path}`, file: join(root, path) });
  }
}

/** What a served namespace's dist at `distDir` serves: its graph's artifacts and its own files. */
export function servedNamespaceDist(distDir: string): ServedDist {
  const graph = servedGraphOf({
    distDir,
    graphsDir: webGraphRecordsDir(distDir),
  });
  if (graph === null) {
    throw new Error(
      `${distDir} names no served graph (.build-graph) — main has never been built, or its dist predates graph pins`,
    );
  }
  const memo = new Map<string, readonly string[]>();
  const files: ServedDist["files"] = [];
  for (const name of readdirSync(distDir)) {
    if (name === "artifacts" || name.startsWith(".")) continue;
    walk(distDir, name, memo, files);
  }
  for (const name of graph.names)
    walk(distDir, `artifacts/${name}`, memo, files);
  return { dir: distDir, files };
}

/** What a release dist serves: everything in it. */
export function releaseDist(distDir: string): ServedDist {
  const files: ServedDist["files"] = [];
  const memo = new Map<string, readonly string[]>();
  for (const name of readdirSync(distDir)) {
    if (name.startsWith(".")) continue;
    walk(distDir, name, memo, files);
  }
  return { dir: distDir, files };
}

const ArtifactMetaSchema = z
  .object({ kind: z.string(), pluginPath: z.string() })
  .passthrough();

/** What a served file is built from, as far as its artifact's meta says. */
export type SourceOf =
  /** A plugin module that still exists in this checkout. */
  | { kind: "source"; path: string }
  /** No plugin module behind it: a route chunk, a vendor file, a dist asset. */
  | { kind: "none" }
  /** A plugin module this checkout no longer has: an older build's artifact. */
  | { kind: "gone"; guess: string };

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".jsx", ".css"];

/**
 * The repo file a served path is built from: the nearest artifact dir above
 * it whose `meta.json` names a plugin, and the path inside it (an
 * artifact keeps its modules at their plugin-relative paths; a bare
 * `index.js` / `__plugin.js` / `<kind>.js` is the kind's barrel).
 */
export function sourceOf(
  served: { path: string; file: string },
  repoRoot: string,
  metaMemo: Map<string, z.infer<typeof ArtifactMetaSchema> | null>,
): SourceOf {
  const segments = served.path.split("/").filter((s) => s !== "");
  const distRoot = served.file.slice(
    0,
    served.file.length - served.path.length,
  );
  for (let i = segments.length - 1; i >= 1; i--) {
    const dir = join(distRoot, ...segments.slice(0, i));
    let meta = metaMemo.get(dir);
    if (meta === undefined) {
      const file = join(dir, "meta.json");
      const parsed = existsSync(file)
        ? ArtifactMetaSchema.safeParse(JSON.parse(readFileSync(file, "utf8")))
        : null;
      meta = parsed?.success === true ? parsed.data : null;
      metaMemo.set(dir, meta);
    }
    if (meta === null) continue;
    const rel = segments.slice(i).join("/");
    const stem = rel.includes("/")
      ? rel.replace(/\.[^./]+$/, "")
      : `${rel === "exhibits.js" ? "exhibits" : meta.kind}/index`;
    const base = `plugins/${meta.pluginPath}/${stem}`;
    for (const ext of SOURCE_EXTENSIONS) {
      if (existsSync(join(repoRoot, base + ext))) {
        return { kind: "source", path: base + ext };
      }
    }
    return { kind: "gone", guess: `${base}.ts` };
  }
  return { kind: "none" };
}
