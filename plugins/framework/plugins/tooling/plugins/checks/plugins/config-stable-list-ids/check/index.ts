import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfigDescriptorsByOriginPath } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  APP_SCOPE_DIR,
  CONFIG_HASH_RE,
  mapConfigLists,
} from "@plugins/config_v2/core";
import { parse as parseJsonc } from "jsonc-parser";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";

// Wedge-breaker for a metadata-only git read: far above any real duration,
// because starvation under a saturated check run is what these suffer, not
// slowness. Same reasoning as `infra/worktree`'s bounds, which carry the
// measurements.
const GIT_TIMEOUT_MS = 60_000;

// A scoped override (config/<hier>/@app/<id>/<name>.jsonc) is a base-anchored
// delta: its schema anchors to the BASE origin (config/<hier>/<name>.origin.jsonc).
// No scoped origin is ever committed. Strip a trailing "@app/<id>/" segment to
// recover that base anchor; a non-scoped path is returned unchanged. Mirrors the
// sibling `config-origins-in-sync` check.
const SCOPE_SEG_RE = new RegExp(`/${APP_SCOPE_DIR}/[^/]+/([^/]+)$`);
function stripScopeSegment(p: string): string {
  return p.replace(SCOPE_SEG_RE, "/$1");
}

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const HINT =
  "Identity-bearing list rows need a stable, content-independent id so external " +
  'state (e.g. saved row order) survives edits. Add a bare slug id, e.g. "id": "online".';

const check: Check = {
  id: "config-stable-list-ids",
  description:
    "Every identity-bearing config listField (stableIdentity) row carries an explicit, unique id",
  async run() {
    const root = await getWorktreeRoot();
    const configDir = join(root, "config");
    if (!existsSync(configDir)) return { ok: true };

    // Map <hier>/<name>.origin.jsonc → ConfigDescriptor. Same discovery the
    // sibling check reuses.
    const descriptorsByOriginRel = await loadConfigDescriptorsByOriginPath({
      root,
    });

    const result = await spawnCaptured(
      ["git", "ls-files", "--others", "--cached", "--", "config/"],
      { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
    );
    const allConfigFiles = result.stdout.trim().split("\n").filter(Boolean);

    for (const relFromRoot of allConfigFiles) {
      if (!relFromRoot.endsWith(".jsonc")) continue;
      const filePath = join(root, relFromRoot);
      if (!existsSync(filePath)) continue;

      // Resolve the file to its owning descriptor via the same anchor trick the
      // sibling uses: a base override, an @app/<id>/ scoped delta, and an origin
      // all anchor to the base origin.
      const originRel = stripScopeSegment(relFromRoot)
        .replace(/^config\//, "")
        .replace(/\.jsonc$/, ".origin.jsonc");
      const descriptor = descriptorsByOriginRel.get(originRel);
      if (!descriptor) continue;

      const raw = readFileSync(filePath, "utf8");
      const match = CONFIG_HASH_RE.exec(raw);
      const body = match ? raw.slice(match[0].length) : raw;
      const doc = parseJsonc(body) as Record<string, unknown> | undefined;
      if (!doc || typeof doc !== "object") continue;

      // Every identity-bearing list INSTANCE, at any nesting depth — a nested
      // durable-key list is exactly the case a human forgets to hand-write ids
      // for. `mapConfigLists` owns the walk; this only judges one list. It
      // returns a document we discard: the visitor reads, it never rewrites.
      const failures: CheckResult[] = [];
      mapConfigLists(doc, descriptor.fields, (rows, field, path) => {
        if (failures.length > 0 || field.stableIdentity !== true) return;

        // Ids must be unique within ONE list instance — two sibling nested lists
        // under different parent rows are separate identity spaces.
        const seen = new Set<string>();
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          if (!row || typeof row !== "object" || Array.isArray(row)) continue;
          const id = row.id;
          const label =
            typeof row.name === "string" && row.name.length > 0
              ? `"${row.name}"`
              : `#${index}`;

          if (typeof id !== "string" || id.length === 0) {
            failures.push({
              ok: false,
              message: `${relFromRoot}: row ${label} in list "${path}" has no explicit "id"`,
              hint: HINT,
            });
            return;
          }
          if (seen.has(id)) {
            failures.push({
              ok: false,
              message: `${relFromRoot}: two rows in list "${path}" share id "${id}"`,
              hint: HINT,
            });
            return;
          }
          seen.add(id);
        }
      });
      if (failures.length > 0) return failures[0]!;
    }

    return { ok: true };
  },
};

export default check;
