// The deployed FACETED tree follows what changed, end to end: an ordinary file
// added under a plugin, and a function body edited, leave
// `plugin-view.facets-tree`'s ETag where it was (a 304 — the facets do not see
// them), while a plugin added, an export added to it and the plugin removed
// each reach the served tree — timed from the write to the first read that
// shows it. The first read starts the faceted-tree worker (a cold build); a
// module the worker loaded, rewritten, ends its session and a fresh worker
// serves the next read.
//
// Writes a throwaway plugin into THIS checkout's `plugins/` and removes it,
// pass or fail.
//
//   ./equin run plugins/plugin-meta/plugins/plugin-tree/e2e/facets-tree-live.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import { agentFetch } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const HOST = join(PLUGINS_DIR, "plugin-meta", "plugins", "plugin-tree");
const PROBE_FILE = join(HOST, "scripts", "e2e-facets-probe.md");
const PROBE_DIR = join(HOST, "plugins", "e2e-facets-probe");
const PROBE_ID = "plugin-meta.plugin-tree.e2e-facets-probe";
const TIMEOUT_MS = 30_000;

interface Node {
  id: string;
  children: Node[];
}
interface Read {
  status: number;
  etag: string | null;
  nodes: Map<string, Node>;
}

async function read(etag?: string | null): Promise<Read> {
  const res = await agentFetch("/api/resources/plugin-view.facets-tree", {
    headers: etag ? { "if-none-match": etag } : {},
  });
  const nodes = new Map<string, Node>();
  if (res.status === 200) {
    const body = (await res.json()) as { value: { plugins: Node[] } };
    const walk = (list: Node[]) => {
      for (const n of list) {
        nodes.set(n.id, n);
        walk(n.children);
      }
    };
    walk(body.value.plugins);
  } else if (res.status !== 304) {
    throw new Error(
      `GET plugin-view.facets-tree: ${res.status} ${await res.text()}`,
    );
  }
  return { status: res.status, etag: res.headers.get("etag"), nodes };
}

/** Read until `done` holds; how long that took from `since`. */
async function until(
  what: string,
  since: number,
  done: (r: Read) => boolean,
  timeoutMs = TIMEOUT_MS,
): Promise<number> {
  for (;;) {
    const r = await read();
    if (done(r)) return performance.now() - since;
    if (performance.now() - since > timeoutMs) {
      throw new Error(`${what}: not seen within ${timeoutMs} ms`);
    }
    await Bun.sleep(100);
  }
}

function cleanup(): void {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  rmSync(PROBE_FILE, { force: true });
}

const core = (body: string) =>
  `export function probe(): number {\n  ${body}\n}\n`;
/** Whether the served node names `name` anywhere (its exports facet). */
const names = (n: Node | undefined, name: string) =>
  n !== undefined && JSON.stringify(n).includes(name);

try {
  let t = performance.now();
  const first = await read();
  if (first.status !== 200 || first.etag === null) {
    throw new Error(`first read: ${first.status}, etag ${first.etag}`);
  }
  const plugins = first.nodes.size;
  console.log(
    `tree: ${plugins} plugins, etag ${first.etag} (first read ${(performance.now() - t).toFixed(0)} ms)`,
  );

  t = performance.now();
  mkdirSync(join(PROBE_DIR, "core"), { recursive: true });
  writeFileSync(join(PROBE_DIR, "core", "impl.ts"), core("return 1;"));
  writeFileSync(
    join(PROBE_DIR, "core", "index.ts"),
    `export { probe } from "./impl";\n`,
  );
  writeFileSync(join(PROBE_DIR, "package.json"), `{ "name": "probe" }\n`);
  console.log(
    `plugin added → seen in ${(
      await until("added", t, (r) => r.nodes.has(PROBE_ID))
    ).toFixed(0)} ms`,
  );
  const settled = await read();

  // An ordinary file, and a body edit: not a facet change.
  writeFileSync(PROBE_FILE, "probe\n");
  writeFileSync(join(PROBE_DIR, "core", "impl.ts"), core("return 2;"));
  await Bun.sleep(3_000); // the watcher's batch, and its refresh
  const quiet = await read(settled.etag);
  console.log(`ordinary file + body edit → ${quiet.status} (want 304)`);
  if (quiet.status !== 304) throw new Error("a non-facet edit moved the tree");

  t = performance.now();
  writeFileSync(
    join(PROBE_DIR, "core", "index.ts"),
    `export { probe } from "./impl";\nexport const probeAdded = 1;\n`,
  );
  console.log(
    `export added → seen in ${(
      await until("export", t, (r) =>
        names(r.nodes.get(PROBE_ID), "probeAdded"),
      )
    ).toFixed(0)} ms`,
  );

  t = performance.now();
  rmSync(PROBE_DIR, { recursive: true, force: true });
  console.log(
    `plugin removed → seen in ${(
      await until(
        "removed",
        t,
        (r) => !r.nodes.has(PROBE_ID) && r.nodes.size === plugins,
      )
    ).toFixed(0)} ms`,
  );
  // A module the worker loaded, rewritten (same bytes): its index was made by
  // code that may no longer be on disk, so the session ends and the next read
  // is served by a fresh worker.
  const code = join(
    HOST,
    "plugins",
    "faceted",
    "core",
    "internal",
    "faceted-index.ts",
  );
  const before = await read();
  t = performance.now();
  writeFileSync(code, readFileSync(code, "utf8"));
  console.log(
    `worker code touched → new tree served in ${(
      await until(
        "code touched",
        t,
        (r) =>
          r.status === 200 &&
          r.etag !== before.etag &&
          r.nodes.size === plugins,
        300_000,
      )
    ).toFixed(0)} ms`,
  );
  console.log("PASS");
} finally {
  cleanup();
}
