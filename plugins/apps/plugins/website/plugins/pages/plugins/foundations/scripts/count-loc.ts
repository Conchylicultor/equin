/**
 * Recounts the iceberg's lines of code per layer and rewrites
 * `core/layer-loc.ts`:
 *
 *   ./equin run plugins/apps/plugins/website/plugins/pages/plugins/foundations/scripts/count-loc.ts
 *
 * What counts: every git-tracked source file (`SOURCE_EXTENSIONS`) the repo's
 * own file-kind classifier calls code — tests, test support and generated
 * files are left out — and no e2e script (they verify the app, they are not
 * part of it). Lines are newline-separated lines, blank ones included.
 *
 * Which layer a file counts toward: the longest `LAYER_OF` prefix matching its
 * path. A file no prefix claims fails the run, naming it — a new top-level
 * plugin is placed in a layer here, never dropped silently.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { fileKindOf } from "@plugins/code-explorer/plugins/file-kind/core";

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|go|rs|css)$/;

type LayerKey =
  | "apps"
  | "shell"
  | "primitives"
  | "plugins"
  | "data"
  | "state"
  | "background"
  | "watching"
  | "machine"
  | "loop";

/** Path prefix → the layer its files count toward; `null` = not part of the app. */
const LAYER_OF: Record<string, LayerKey | null> = {
  // ── The apps ─────────────────────────────────────────────────────────────
  "plugins/apps/": "apps",

  // ── Shell & chrome ───────────────────────────────────────────────────────
  "plugins/shell/": "shell",
  "plugins/apps-core/": "shell",
  "plugins/ui/": "shell",
  "plugins/layouts/": "shell",
  "plugins/hints/": "shell",
  "plugins/companions/": "shell",
  "plugins/audience/": "shell",
  "plugins/fullscreen/": "shell",
  "plugins/phone-window/": "shell",
  "plugins/screenshot/": "shell",
  "plugins/reorder/": "shell",

  // ── UI primitives ────────────────────────────────────────────────────────
  "plugins/primitives/": "primitives",
  "plugins/fields/": "primitives",
  "plugins/page/": "primitives",
  "plugins/active-data/": "primitives",
  "plugins/ids/": "primitives",
  "plugins/map/": "primitives",
  "plugins/media/": "primitives",
  "plugins/music/": "primitives",
  "plugins/search/": "primitives",
  "plugins/history/": "primitives",
  "plugins/tag-tree/": "primitives",
  "plugins/runs/": "primitives",
  "plugins/stats/": "primitives",

  // ── The plugin system ────────────────────────────────────────────────────
  "plugins/framework/": "plugins",
  "plugins/plugin-meta/": "plugins",
  "plugins/framework/plugins/tooling/plugins/boundaries/": "plugins",
  "plugins/framework/plugins/tooling/plugins/codegen/": "plugins",
  "plugins/framework/plugins/tooling/plugins/collected-dir/": "plugins",
  "plugins/framework/plugins/tooling/plugins/web-artifacts/": "plugins",

  // ── Data in motion ───────────────────────────────────────────────────────
  "plugins/network/": "data",
  "plugins/framework/plugins/browser-server/": "data",

  // ── Where state lives ────────────────────────────────────────────────────
  "plugins/database/": "state",
  "plugins/config_v2/": "state",
  "plugins/auth/": "state",
  "plugins/backup/": "state",
  "plugins/integrations/": "state",
  "plugins/page/plugins/markdown-apply/": "state",
  "plugins/page/plugins/annotations/": "state",
  "plugins/infra/plugins/secrets/": "state",
  "plugins/infra/plugins/entities/": "state",
  "plugins/infra/plugins/entity-extensions/": "state",
  "plugins/infra/plugins/attachments/": "state",
  "plugins/infra/plugins/trash/": "state",
  "plugins/infra/plugins/retention/": "state",

  // ── Background & reactions ───────────────────────────────────────────────
  "plugins/infra/plugins/jobs/": "background",
  "plugins/infra/plugins/events/": "background",
  "plugins/infra/plugins/file-watcher/": "background",
  "plugins/infra/plugins/background/": "background",

  // ── Watching itself ──────────────────────────────────────────────────────
  "plugins/debug/": "watching",
  "plugins/reports/": "watching",
  "plugins/infra/plugins/runtime-profiler/": "watching",
  "plugins/infra/plugins/stack-sampler/": "watching",
  "plugins/infra/plugins/health/": "watching",
  "plugins/infra/plugins/file-sink/": "watching",
  "plugins/infra/plugins/events-test/": "watching",

  // ── The machine ──────────────────────────────────────────────────────────
  "plugins/infra/": "machine",
  "plugins/packages/": "machine",
  "plugins/installer/": "machine",
  "plugins/release/": "machine",
  "plugins/toolchain/": "machine",
  "plugins/framework/plugins/central-core/": "machine",
  "plugins/framework/plugins/http-router/": "machine",
  "plugins/framework/plugins/principal/": "machine",
  "gateway/": "machine",
  "tauri/": "machine",

  // ── The loop ─────────────────────────────────────────────────────────────
  "plugins/conversations/": "loop",
  "plugins/tasks/": "loop",
  "plugins/wish/": "loop",
  "plugins/build/": "loop",
  "plugins/review/": "loop",
  "plugins/code-explorer/": "loop",
  "plugins/upstream/": "loop",
  "plugins/framework/plugins/cli/": "loop",
  "plugins/framework/plugins/tooling/": "loop",
  "plugins/infra/plugins/worktree/": "loop",
  "plugins/infra/plugins/claude-cli/": "loop",
  "plugins/infra/plugins/mcp/": "loop",
  "plugins/infra/plugins/git/": "loop",
  "eslint.config.ts": "loop",

  // ── Not counted: not part of the app ─────────────────────────────────────
  "test/": null, // test setup outside the per-file test layout
  "research/": null, // design docs' repro snippets
  "sidequests/": null, // side projects
  "prototypes/": null, // the prototypes' template, not the app
  "vitest.config.ts": null,
};

const PREFIXES = Object.keys(LAYER_OF).sort((a, b) => b.length - a.length);

function layerOf(path: string): LayerKey | null {
  const prefix = PREFIXES.find((p) => path.startsWith(p));
  if (prefix === undefined)
    throw new Error(
      `count-loc: no layer claims ${path} — add its prefix to LAYER_OF`,
    );
  return LAYER_OF[prefix] ?? null;
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\0")
  .filter(
    (f) =>
      SOURCE_EXTENSIONS.test(f) &&
      fileKindOf(f) === "code" &&
      !f.includes("/e2e/"),
  );

const loc: Record<LayerKey, number> = {
  apps: 0,
  shell: 0,
  primitives: 0,
  plugins: 0,
  data: 0,
  state: 0,
  background: 0,
  watching: 0,
  machine: 0,
  loop: 0,
};
for (const f of files) {
  const layer = layerOf(f);
  if (layer === null) continue;
  const text = readFileSync(join(root, f), "utf8");
  if (text === "") continue;
  loc[layer] += text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const out = join(import.meta.dir, "../core/layer-loc.ts");
writeFileSync(
  out,
  `/**
 * Lines of code per iceberg layer (by layer key), tests and generated files
 * excluded. Written by \`scripts/count-loc.ts\` — rerun it to refresh, never
 * edit by hand.
 */
export const LAYER_LOC = {
${Object.entries(loc)
  .map(([k, n]) => `  ${k}: ${n},`)
  .join("\n")}
} as const;
`,
);
const below = Object.entries(loc)
  .filter(([k]) => k !== "apps")
  .reduce((s, [, n]) => s + n, 0);
console.log(loc);
console.log(`below the surface: ${below.toLocaleString("en-US")}`);
