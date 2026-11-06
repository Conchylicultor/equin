// The deployed structure tree follows what changed, end to end: an ordinary
// file added under a plugin leaves `plugin-view.tree`'s ETag where it was (a
// 304), while a plugin added, its barrel edited and the plugin removed each
// reach the served tree — timed from the write to the first read that shows it.
//
// Writes a throwaway plugin into THIS checkout's `plugins/` and removes it,
// pass or fail.
//
//   ./equin run plugins/plugin-meta/plugins/plugin-tree/e2e/structure-tree-live.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import { agentFetch } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const HOST = join(PLUGINS_DIR, "plugin-meta", "plugins", "plugin-tree");
const PROBE_FILE = join(HOST, "scripts", "e2e-probe.md");
const PROBE_DIR = join(HOST, "plugins", "e2e-probe");
const PROBE_ID = "plugin-meta.plugin-tree.e2e-probe";
const TIMEOUT_MS = 15_000;

interface Node {
  id: string;
  description?: string;
  children: Node[];
}
interface Read {
  status: number;
  etag: string | null;
  nodes: Map<string, Node>;
}

async function read(etag?: string | null): Promise<Read> {
  const res = await agentFetch("/api/resources/plugin-view.tree", {
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
    throw new Error(`GET plugin-view.tree: ${res.status} ${await res.text()}`);
  }
  return { status: res.status, etag: res.headers.get("etag"), nodes };
}

/** Read until `done` holds; how long that took from `since`. */
async function until(
  what: string,
  since: number,
  done: (r: Read) => boolean,
): Promise<number> {
  for (;;) {
    const r = await read();
    if (done(r)) return performance.now() - since;
    if (performance.now() - since > TIMEOUT_MS) {
      throw new Error(`${what}: not seen within ${TIMEOUT_MS} ms`);
    }
    await Bun.sleep(100);
  }
}

function cleanup(): void {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  rmSync(PROBE_FILE, { force: true });
}

const barrel = (description: string) =>
  `export default {\n  description: ${JSON.stringify(description)},\n};\n`;

try {
  const first = await read();
  if (first.status !== 200 || first.etag === null) {
    throw new Error(`first read: ${first.status}, etag ${first.etag}`);
  }
  const plugins = first.nodes.size;
  console.log(`tree: ${plugins} plugins, etag ${first.etag}`);

  // An ordinary file: not a structure change.
  writeFileSync(PROBE_FILE, "probe\n");
  await Bun.sleep(1_500); // the watcher's batch, and its refresh
  const quiet = await read(first.etag);
  console.log(`ordinary file added → ${quiet.status} (want 304)`);
  if (quiet.status !== 304) throw new Error("an ordinary file moved the tree");

  let t = performance.now();
  mkdirSync(join(PROBE_DIR, "web"), { recursive: true });
  writeFileSync(join(PROBE_DIR, "web", "index.ts"), barrel("probe one"));
  console.log(
    `plugin added → seen in ${(
      await until("added", t, (r) => r.nodes.has(PROBE_ID))
    ).toFixed(0)} ms`,
  );

  t = performance.now();
  writeFileSync(join(PROBE_DIR, "web", "index.ts"), barrel("probe two"));
  console.log(
    `barrel edited → seen in ${(
      await until(
        "edited",
        t,
        (r) => r.nodes.get(PROBE_ID)?.description === "probe two",
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
  console.log("PASS");
} finally {
  cleanup();
}
