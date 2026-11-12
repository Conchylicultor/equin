import { z } from "zod";

// What a failed module load proves, learned from the server instead of guessed
// from the browser's message. "Importing a module script failed." (WebKit) and
// "Failed to fetch dynamically imported module" (Chromium) read the same for a
// file a rebuild retired, a network error while the gateway restarts, and a
// server failing to serve a file it should — and they name at most the entry,
// never the file of its graph that failed. So the tab walks the failing
// module's own static import graph, as ITS import map resolves it (the build it
// booted), asking the server for each file:
//
// - `missing` — the server answered 404 for a file of that graph. A static
//   import that 404s fails the whole graph, so this file is a sufficient cause.
//   The tab's half of the proof that version skew explains the failure; the
//   server re-checks it (reports/core's version-skew).
// - `served` — every file is there: the load failed for another reason (an
//   evaluation error, a transient fetch failure). Nothing explains it.
// - `unreachable` / `status` — the server did not answer, or answered another
//   status. Proves nothing; the failure stays loud.
// - `unprobed` — the failing module is not an artifact file of this page's
//   import map (a dev server), so there is nothing to ask about.
//
// Only `missing` ever quiets a report, and only once the server agrees.

export type LoadProbe =
  | { kind: "missing"; path: string }
  | { kind: "served"; files: number }
  | { kind: "unreachable"; path: string; error: string }
  | { kind: "status"; path: string; status: number }
  | { kind: "unprobed"; why: string };

/** One answer of the server about one file. */
export type FileAnswer =
  { kind: "status"; status: number } | { kind: "unreachable"; error: string };

/** How the probe talks to the page and the server (the test seam). */
export interface LoadProbeIo {
  /**
   * The page's import map: bare specifier → URL (exact keys), or null when the
   * page has none (a dev server resolves modules itself).
   */
  importMap: () => ReadonlyMap<string, string> | null;
  /** The server's answer for one file (HEAD, never a cached answer). */
  head: (url: string) => Promise<FileAnswer>;
  /**
   * The artifact's build metadata (`/artifacts/<name>/meta.json`): its
   * answer, and the parsed body when it is 200.
   */
  meta: (
    url: string,
  ) => Promise<{ answer: FileAnswer; body: unknown | undefined }>;
  /** The page's origin, to resolve the import map's paths against. */
  origin: string;
}

// What the build records of each artifact (web-artifacts' meta.json): the
// static imports of every file it emitted, as written — bare specifiers the
// import map resolves, `./x.mjs` for a chunk of the same artifact.
const ArtifactMetaSchema = z.object({
  staticImportsByFile: z.record(z.string(), z.array(z.string())),
});

/** `/artifacts/<name>/<file>` of a URL on this origin, or null. */
function artifactFileOf(
  url: URL,
  origin: string,
): { name: string; file: string; path: string } | null {
  if (url.origin !== origin) return null;
  const m = /^\/artifacts\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!m?.[1] || !m[2]) return null;
  return { name: m[1], file: m[2], path: url.pathname };
}

/**
 * A probe whose answers are shared by the failures of one burst: one failure
 * usually comes with others over the same files (a retired build fails every
 * plugin that reaches its files), so each file is asked about once. Keep one
 * per burst, never per page — an answer is true when it was given, and a file
 * served (or unreachable) an hour ago may be retired now.
 */
export function createLoadProbe(io: LoadProbeIo): {
  probe: (specifier: string) => Promise<LoadProbe>;
} {
  const answers = new Map<string, Promise<FileAnswer>>();
  const metas = new Map<
    string,
    Promise<{ answer: FileAnswer; body: unknown | undefined }>
  >();
  const askFile = (path: string): Promise<FileAnswer> => {
    let p = answers.get(path);
    if (!p) {
      p = io.head(path);
      answers.set(path, p);
    }
    return p;
  };
  const askMeta = (name: string) => {
    let p = metas.get(name);
    if (!p) {
      p = io.meta(`/artifacts/${name}/meta.json`);
      metas.set(name, p);
    }
    return p;
  };

  async function probe(specifier: string): Promise<LoadProbe> {
    const map = io.importMap();
    if (map === null)
      return { kind: "unprobed", why: "the page has no import map" };
    const entry = map.get(specifier);
    if (entry === undefined) {
      return { kind: "unprobed", why: `${specifier} is not in the import map` };
    }
    const resolve = (spec: string, from: URL): URL | null => {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        return new URL(spec, from);
      }
      const mapped = map.get(spec);
      return mapped === undefined ? null : new URL(mapped, io.origin);
    };
    const entryUrl = new URL(entry, io.origin);
    if (artifactFileOf(entryUrl, io.origin) === null) {
      return { kind: "unprobed", why: `${entry} is not an artifact file` };
    }

    type Unproven = Exclude<LoadProbe, { kind: "missing" | "served" }>;
    // What one file says: a 404 (`missing`), no proof (`unproven`), or the
    // files it imports, to ask about next.
    type Step =
      | { kind: "missing"; path: string }
      | { kind: "unproven"; why: Unproven }
      | { kind: "imports"; urls: URL[] };
    const stepOf = async (url: URL): Promise<Step> => {
      const at = artifactFileOf(url, io.origin);
      if (at === null) return { kind: "imports", urls: [] };
      const answer = await askFile(at.path);
      if (answer.kind === "unreachable") {
        return {
          kind: "unproven",
          why: { kind: "unreachable", path: at.path, error: answer.error },
        };
      }
      if (answer.status === 404) return { kind: "missing", path: at.path };
      if (answer.status < 200 || answer.status >= 300) {
        return {
          kind: "unproven",
          why: { kind: "status", path: at.path, status: answer.status },
        };
      }
      // The file is served: walk on through what it imports. An artifact
      // without metadata (a vendor set) is one directory written whole, so a
      // file of it served says its siblings are.
      const meta = await askMeta(at.name);
      if (meta.answer.kind === "unreachable") {
        return {
          kind: "unproven",
          why: {
            kind: "unreachable",
            path: `/artifacts/${at.name}/meta.json`,
            error: meta.answer.error,
          },
        };
      }
      if (meta.answer.status !== 200) return { kind: "imports", urls: [] };
      const parsed = ArtifactMetaSchema.safeParse(meta.body);
      if (!parsed.success) return { kind: "imports", urls: [] };
      const urls: URL[] = [];
      for (const spec of parsed.data.staticImportsByFile[at.file] ?? []) {
        const target = resolve(spec, url);
        if (target !== null) urls.push(target);
      }
      return { kind: "imports", urls };
    };

    const seen = new Set<string>([entryUrl.href]);
    let frontier: URL[] = [entryUrl];
    let firstUnproven: Unproven | undefined;
    // Level by level: every file of a level is asked at once, the browser
    // queues what it cannot send yet. Ends when the graph is walked — it is
    // finite, and each file is visited once — or a 404 is found.
    while (frontier.length > 0) {
      const steps = await Promise.all(frontier.map(stepOf));
      const next: URL[] = [];
      for (const step of steps) {
        if (step.kind === "missing") return step;
        if (step.kind === "unproven") {
          firstUnproven ??= step.why;
          continue;
        }
        for (const target of step.urls) {
          if (seen.has(target.href)) continue;
          seen.add(target.href);
          next.push(target);
        }
      }
      frontier = next;
    }
    return firstUnproven ?? { kind: "served", files: seen.size };
  }

  return { probe };
}

/** The probe's finding, in words, for the report's message. */
export function describeLoadProbe(p: LoadProbe): string {
  switch (p.kind) {
    case "missing":
      return `the server answered 404 for ${p.path}, a file of this tab's build`;
    case "served":
      return `every file of its import graph is served (${p.files} checked), so no missing file explains it`;
    case "unreachable":
      return `the server could not be reached for ${p.path} (${p.error})`;
    case "status":
      return `the server answered ${p.status} for ${p.path}`;
    case "unprobed":
      return `not probed: ${p.why}`;
  }
}

/** The page's own probe IO: its import map, and the server via fetch. */
export function pageLoadProbeIo(): LoadProbeIo {
  const ask = async (
    url: string,
    method: "HEAD" | "GET",
  ): Promise<{ answer: FileAnswer; res: Response | null }> => {
    try {
      const res = await fetch(url, { method, cache: "no-store" });
      return { answer: { kind: "status", status: res.status }, res };
    } catch (err) {
      // A fetch that never got an answer (a network error) — the fact this
      // probe exists to tell apart from a 404, kept as its own arm.
      return {
        answer: {
          kind: "unreachable",
          error: err instanceof Error ? err.message : String(err),
        },
        res: null,
      };
    }
  };
  return {
    origin: window.location.origin,
    importMap: () => {
      const el = document.querySelector('script[type="importmap"]');
      if (el === null) return null;
      // The page booted from this map, so it parses; if it ever does not,
      // the throw names it rather than a probe that found nothing.
      const { imports } = z
        .object({ imports: z.record(z.string(), z.string()) })
        .parse(JSON.parse(el.textContent ?? ""));
      return new Map(Object.entries(imports));
    },
    head: async (url) => (await ask(url, "HEAD")).answer,
    meta: async (url) => {
      const { answer, res } = await ask(url, "GET");
      if (res === null || !res.ok) return { answer, body: undefined };
      return { answer, body: await res.json() };
    },
  };
}
