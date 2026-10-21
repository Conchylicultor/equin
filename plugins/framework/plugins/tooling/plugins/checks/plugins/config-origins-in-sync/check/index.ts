import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import {
  renderConfigOriginContent,
  loadConfigDescriptorsByOriginPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  computeHash,
  APP_SCOPE_DIR,
  CONFIG_HASH_RE,
} from "@plugins/config_v2/core";
import { parse as parseJsonc } from "jsonc-parser";
import type { ConfigDescriptor, JsonValue } from "@plugins/config_v2/core";
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
// delta: its // @hash and schema anchor to the BASE origin
// (config/<hier>/<name>.origin.jsonc). No scoped origin is ever committed. Strip a
// trailing "@app/<id>/" segment to recover that base anchor; a non-scoped path is
// returned unchanged.
const SCOPE_SEG_RE = new RegExp(`/${APP_SCOPE_DIR}/[^/]+/([^/]+)$`);
function stripScopeSegment(p: string): string {
  return p.replace(SCOPE_SEG_RE, "/$1");
}

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

// Validate a config file's content against its descriptor's Zod schema. Returns
// a failure when the parsed document fails — the same `safeParse` the runtime
// applies in `readTypedConfig`, lifted to check time so a schema that drifts
// from stored data is caught at `./singularity check`, not silently surfaced
// months later as a `kind: "invalid"` conflict banner (and an HTTP 400 on the
// reset button) the first time someone opens the file in settings.
function validateSchema(
  descriptor: ConfigDescriptor,
  raw: string,
  rel: string,
): CheckResult {
  const match = CONFIG_HASH_RE.exec(raw);
  const body = match ? raw.slice(match[0].length) : raw;
  const content = parseJsonc(body) as JsonValue;
  const result = descriptor.schema.safeParse(content);
  if (result.success) return { ok: true };
  const issues = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return {
    ok: false,
    message: `${rel} fails the "${descriptor.name}" config schema: ${issues}`,
    hint: "A field's schema changed under stored data. Migrate the file's values to the current schema (or run `./singularity build` to regenerate the origin).",
  };
}

const check: Check = {
  id: "config-origins-in-sync",
  description:
    "config/ origin files match defineConfig defaults, overwrite hashes are consistent, and all content validates against its schema",
  async run() {
    const root = await getWorktreeRoot();
    const configDir = join(root, "config");
    // `renderConfigOriginContent` resolves origin annotations through codegen's
    // shared default provider (see `setDefaultOriginAnnotations`), so the check
    // injects the exact same comment lines the build wrote into committed
    // origins. With no provider registered this is byte-identical to before.
    const expected = await renderConfigOriginContent({ root });
    const descriptorsByOriginRel = await loadConfigDescriptorsByOriginPath({
      root,
    });

    for (const [relPath, content] of expected) {
      const filePath = join(configDir, relPath);
      const rel = `config/${relPath}`;
      if (!existsSync(filePath)) {
        return {
          ok: false,
          message: `${rel} is missing`,
          hint: "Run `./singularity build` to generate it.",
        };
      }
      const raw = readFileSync(filePath, "utf8");
      if (raw !== (await formatGenerated({ file: filePath, content }))) {
        return {
          ok: false,
          message: `${rel} is out of sync with defineConfig defaults`,
          hint: "Run `./singularity build` and commit the regenerated file.",
        };
      }
      const descriptor = descriptorsByOriginRel.get(relPath);
      if (descriptor) {
        const valid = validateSchema(descriptor, raw, rel);
        if (!valid.ok) return valid;
      }
    }

    if (!existsSync(configDir)) return { ok: true };

    const result = await spawnCaptured(
      ["git", "ls-files", "--others", "--cached", "--", "config/"],
      { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
    );
    const allConfigFiles = result.stdout.trim().split("\n").filter(Boolean);

    // Orphan pass: any `*.origin.jsonc` present in the WORKING TREE that
    // `renderConfigOriginContent` did not produce is no longer backed by a
    // `defineConfig` (its descriptor was moved or removed). `./singularity build`
    // prunes these via `pruneOrphanedConfigFiles`, which — like every other
    // codegen step — mutates the working tree only (staging is `push`'s
    // `git add -A` job, never the build's). So orphan-ness must be judged on
    // working-tree presence, not the git index: a file `pruneOrphanedConfigFiles`
    // unlinked is still listed by `--cached` (the index entry lingers until the
    // deletion is committed), and flagging it there would make the build's prune
    // unable to self-heal — the exact contradiction this `existsSync` guard
    // closes, mirroring the working-tree guard the override-hash pass below
    // already applies. A committed orphan never built is still caught: it remains
    // checked out on disk. `expected` keys are relative to configDir;
    // `allConfigFiles` are relative to root — normalize via relative().
    const orphans: string[] = [];
    for (const relFromRoot of allConfigFiles) {
      if (!relFromRoot.endsWith(".origin.jsonc")) continue;
      if (!existsSync(join(root, relFromRoot))) continue;
      const relPath = relative(configDir, join(root, relFromRoot));
      if (!expected.has(relPath)) orphans.push(relFromRoot);
    }
    if (orphans.length > 0) {
      return {
        ok: false,
        message: `Orphaned origin file(s) no longer backed by any defineConfig:\n  ${orphans.join("\n  ")}`,
        hint: "These were generated for a config descriptor that was moved or removed. Run `./singularity build` to prune them automatically (or `git rm` them), then re-run the check.",
      };
    }

    for (const relFromRoot of allConfigFiles) {
      if (
        !relFromRoot.endsWith(".jsonc") ||
        relFromRoot.endsWith(".origin.jsonc")
      )
        continue;

      const filePath = join(root, relFromRoot);
      if (!existsSync(filePath)) continue;

      const raw = readFileSync(filePath, "utf8");
      const match = CONFIG_HASH_RE.exec(raw);
      if (!match) {
        return {
          ok: false,
          message: `${relFromRoot} is missing a // @hash line`,
          hint: "Re-generate the file via `./singularity build`.",
        };
      }
      const hash = match[1]!;

      const originPath = stripScopeSegment(filePath).replace(
        /\.jsonc$/,
        ".origin.jsonc",
      );
      const originRel = relative(root, originPath);
      if (!existsSync(originPath)) {
        return {
          ok: false,
          message: `${relFromRoot} references a hash but ${originRel} does not exist`,
          hint: "Run `./singularity build` to regenerate origin files.",
        };
      }

      const originRaw = readFileSync(originPath, "utf8");
      const originMatch = CONFIG_HASH_RE.exec(originRaw);
      const originBody = originMatch
        ? originRaw.slice(originMatch[0].length)
        : originRaw;
      const originContent = parseJsonc(originBody) as JsonValue;
      const expectedHash = computeHash(originContent);

      if (hash !== expectedHash) {
        return {
          ok: false,
          message: `${relFromRoot} has a stale @hash (got ${hash}, expected ${expectedHash})`,
          hint: `The origin defaults changed. Review ${originRel}, update the overwrites, and set // @hash ${expectedHash} to acknowledge.`,
        };
      }

      // Validate the override document against its schema. A correct @hash only
      // proves the override was written against the current origin's *content* —
      // not that its values still satisfy the current *schema*. This is the gap
      // that let a legacy spacer node sit in a committed override until it blew
      // up at runtime.
      const overrideOriginRel = stripScopeSegment(relFromRoot)
        .replace(/^config\//, "")
        .replace(/\.jsonc$/, ".origin.jsonc");
      const descriptor = descriptorsByOriginRel.get(overrideOriginRel);
      if (descriptor) {
        const valid = validateSchema(descriptor, raw, relFromRoot);
        if (!valid.ok) return valid;
      }
    }

    return { ok: true };
  },
};

export default check;
