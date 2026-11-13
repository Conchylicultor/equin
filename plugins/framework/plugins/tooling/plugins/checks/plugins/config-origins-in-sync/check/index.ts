import { join, relative } from "path";
import { gitBlobId } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  renderConfigOriginContent,
  loadConfigDescriptorsByOriginPath,
  formatGenerated,
  codegenPassOver,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  computeHash,
  APP_SCOPE_DIR,
  CONFIG_HASH_RE,
} from "@plugins/config_v2/core";
import { parse as parseJsonc } from "jsonc-parser";
import type { ConfigDescriptor, JsonValue } from "@plugins/config_v2/core";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";

// A scoped override (config/<hier>/@app/<id>/<name>.jsonc) is a base-anchored
// delta: its // @hash and schema anchor to the BASE origin
// (config/<hier>/<name>.origin.jsonc). No scoped origin is ever committed. Strip a
// trailing "@app/<id>/" segment to recover that base anchor; a non-scoped path is
// returned unchanged.
const SCOPE_SEG_RE = new RegExp(`/${APP_SCOPE_DIR}/[^/]+/([^/]+)$`);
function stripScopeSegment(p: string): string {
  return p.replace(SCOPE_SEG_RE, "/$1");
}

// Validate a config file's content against its descriptor's Zod schema. Returns
// a failure when the parsed document fails — the same `safeParse` the runtime
// applies in `readTypedConfig`, lifted to check time so a schema that drifts
// from stored data is caught at `./equin check`, not silently surfaced
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
    hint: "A field's schema changed under stored data. Migrate the file's values to the current schema (or run `./equin build` to regenerate the origin).",
  };
}

const check: Check = {
  id: "config-origins-in-sync",
  description:
    "config/ origin files match defineConfig defaults, overwrite hashes are consistent, and all content validates against its schema",
  async run(ctx: CheckContext) {
    const repo = await ctx.repo();
    const pass = codegenPassOver(repo);
    const root = pass.root;
    const configDir = join(root, "config");
    // `renderConfigOriginContent` resolves origin annotations through codegen's
    // shared default provider (see `setDefaultOriginAnnotations`), so the check
    // injects the exact same comment lines the build wrote into committed
    // origins. With no provider registered this is byte-identical to before.
    const expected = await renderConfigOriginContent({ pass });
    // Live: the files are validated with each descriptor's zod `schema`,
    // which no evaluated record holds.
    const descriptorsByOriginRel = await loadConfigDescriptorsByOriginPath({
      pass,
      live: true,
    });

    // Each origin is compared by content id: the file set already knows every
    // member's blob id, so an origin whose id is the expected bytes' id IS
    // those bytes — validated from memory, never read. (Every origin was read
    // and compared on every pass: ~500 stats and reads.)
    const originText = new Map<string, string>();
    for (const [relPath, content] of expected) {
      const filePath = join(configDir, relPath);
      const rel = `config/${relPath}`;
      if (!repo.has(rel)) {
        return {
          ok: false,
          message: `${rel} is missing`,
          hint: "Run `./equin build` to generate it.",
        };
      }
      const raw = await formatGenerated({ file: filePath, content });
      if (gitBlobId(raw) !== repo.blobOf(rel)) {
        return {
          ok: false,
          message: `${rel} is out of sync with defineConfig defaults`,
          hint: "Run `./equin build` and commit the regenerated file.",
        };
      }
      originText.set(rel, raw);
      const descriptor = descriptorsByOriginRel.get(relPath);
      if (descriptor) {
        const valid = validateSchema(descriptor, raw, rel);
        if (!valid.ok) return valid;
      }
    }

    // The run's file set (tracked + untracked-not-ignored, minus files deleted
    // in the working tree) — what a commit of this tree holds under config/.
    const allConfigFiles = repo.under("config");
    if (allConfigFiles.length === 0) return { ok: true };

    // Orphan pass: any `*.origin.jsonc` present in the WORKING TREE that
    // `renderConfigOriginContent` did not produce is no longer backed by a
    // `defineConfig` (its descriptor was moved or removed). `./equin build`
    // prunes these via `pruneOrphanedConfigFiles`, which — like every other
    // codegen step — mutates the working tree only (staging is `push`'s
    // `git add -A` job, never the build's). So orphan-ness must be judged on
    // working-tree presence, not the git index: a file `pruneOrphanedConfigFiles`
    // unlinked is still listed by `--cached` (the index entry lingers until the
    // deletion is committed), and flagging it there would make the build's prune
    // unable to self-heal. The run's file set is that working-tree presence: it
    // drops an index entry whose file is gone. A committed orphan never built is
    // still caught: it remains checked out on disk. `expected` keys are relative to configDir;
    // `allConfigFiles` are relative to root — normalize via relative().
    const orphans: string[] = [];
    for (const relFromRoot of allConfigFiles) {
      if (!relFromRoot.endsWith(".origin.jsonc")) continue;
      const relPath = relative(configDir, join(root, relFromRoot));
      if (!expected.has(relPath)) orphans.push(relFromRoot);
    }
    if (orphans.length > 0) {
      return {
        ok: false,
        message: `Orphaned origin file(s) no longer backed by any defineConfig:\n  ${orphans.join("\n  ")}`,
        hint: "These were generated for a config descriptor that was moved or removed. Run `./equin build` to prune them automatically (or `git rm` them), then re-run the check.",
      };
    }

    for (const relFromRoot of allConfigFiles) {
      if (
        !relFromRoot.endsWith(".jsonc") ||
        relFromRoot.endsWith(".origin.jsonc")
      )
        continue;

      const filePath = join(root, relFromRoot);
      const raw = await repo.read(relFromRoot);
      // Removed since the set was taken: no file, nothing to judge.
      if (raw === null) continue;
      const match = CONFIG_HASH_RE.exec(raw);
      if (!match) {
        return {
          ok: false,
          message: `${relFromRoot} is missing a // @hash line`,
          hint: "Re-generate the file via `./equin build`.",
        };
      }
      const hash = match[1]!;

      const originPath = stripScopeSegment(filePath).replace(
        /\.jsonc$/,
        ".origin.jsonc",
      );
      const originRel = relative(root, originPath);
      if (!repo.has(originRel)) {
        return {
          ok: false,
          message: `${relFromRoot} references a hash but ${originRel} does not exist`,
          hint: "Run `./equin build` to regenerate origin files.",
        };
      }

      // Every committed origin is an expected one (an orphan failed above), and
      // equal to its expected bytes, so its text is already in memory.
      const originRaw = originText.get(originRel);
      if (originRaw === undefined)
        throw new Error(
          `${originRel} is in the file set but was not rendered — the orphan pass above should have reported it`,
        );
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
