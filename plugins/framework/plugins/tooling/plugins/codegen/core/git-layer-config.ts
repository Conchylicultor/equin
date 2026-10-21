import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  computeHash,
  parseConfigFile,
  readTypedConfig,
} from "@plugins/config_v2/core";
import type {
  ConfigDescriptor,
  ConfigProxy,
  ConfigValues,
  JsonValue,
} from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";

/**
 * The same `// @hash`-header contract as `fileConfigProxy`, but STRICT: a
 * file that exists without the header is a corrupt config, not an unhashed one,
 * so reading it throws instead of quietly parsing the body with `hash: null`.
 *
 * The lenient proxy has to stay lenient — it is also the WRITE path, and it reads
 * back files it may be about to create. A build-time *reader* has no such excuse:
 * it is looking at a committed file that codegen wrote with a header, and a
 * missing one means the file was hand-edited or truncated. Silently accepting it
 * would let the reader compute a closure from half a config.
 */
function strictReadOnlyFileConfigProxy(filePath: string): ConfigProxy {
  return {
    read() {
      if (!existsSync(filePath)) return null;
      return parseConfigFile(readFileSync(filePath, "utf-8"), filePath);
    },
    write() {
      throw new Error(`readGitLayerConfig proxy is read-only: ${filePath}`);
    },
    exists() {
      return existsSync(filePath);
    },
  };
}

/**
 * The origin proxy, minus a STALE origin document.
 *
 * `config/<path>/<name>.origin.jsonc` is a *materialization* of the descriptor's
 * defaults — `generateConfigOrigins` writes it with `// @hash
 * computeHash(defaults)`. So a header that no longer matches the descriptor's
 * current defaults says one thing: this file was written by an older shape of
 * the descriptor and has not been regenerated yet. The descriptor is the source;
 * the file is its output. Reading the stale output would answer with the
 * PREVIOUS build's value.
 *
 * That matters inside a single build. Registry codegen runs BEFORE
 * `generateConfigOrigins`, so an edit to a descriptor's defaults (e.g. a
 * composition manifest in `plugin-meta/composition/core/config.ts`) would
 * otherwise not reach the registries until a SECOND build — and the first build
 * would fail `plugins-registry-in-sync` for no visible reason. Dropping the stale
 * origin here makes one build enough.
 *
 * This is the same staleness rule `nonStaleOverrideContent`
 * (`config_v2/core/internal/tier-logic.ts`) already applies to the OVERRIDE layer
 * — an override whose `@hash` no longer matches its origin is ignored — applied
 * one layer down, to the origin against its descriptor.
 *
 * SCOPE. The comparison basis is `descriptor.defaults`, so this only works for a
 * descriptor whose origin IS its defaults — `originDefaultsFrom: "descriptor"`.
 * For the other arm (`"build"`: reorder directives, whose origin is the live
 * contribution catalog an async preparer materializes during codegen) the
 * committed hash is over a document `descriptor.defaults` never equals, so every
 * read here would answer "stale". {@link readGitLayerConfig} therefore accepts
 * only the `"descriptor"` arm — a `"build"` descriptor is a tsc error at the call
 * site, not a caveat to remember. The throw below covers the paths where that
 * type is erased (a cast, a bare `ConfigDescriptor` in a container, a value
 * narrowed out of a dynamically imported barrel).
 */
function nonStaleOriginProxy(
  descriptor: ConfigDescriptor,
  filePath: string,
): ConfigProxy {
  if (descriptor.originDefaultsFrom !== "descriptor") {
    throw new Error(
      `readGitLayerConfig: "${descriptor.name}" declares originDefaultsFrom: "${descriptor.originDefaultsFrom}", ` +
        `so its committed origin is materialized at build time and can never match computeHash(descriptor.defaults). ` +
        `Read it through the build's origin renderer instead.`,
    );
  }
  const inner = strictReadOnlyFileConfigProxy(filePath);
  const read = (): { content: JsonValue; hash: string | null } | null => {
    const data = inner.read();
    if (data === null) return null;
    // A file with no header at all is impossible here — the strict proxy already
    // threw. A header that no longer matches means "written by an older
    // descriptor", which is exactly the stale case.
    const current = computeHash(descriptor.defaults as unknown as JsonValue);
    return data.hash !== null && data.hash !== current ? null : data;
  };
  return { read, write: inner.write, exists: () => read() !== null };
}

/**
 * The GIT-LAYER value of one config, read straight off disk with no server
 * runtime — what the committed repo says, ignoring any per-worktree user edits.
 *
 * This is the read the build-time CHECKS and registry codegen need, and it is
 * deliberately narrower than `readEffectiveConfigFromDisk`: a check adjudicates
 * what is committed, so a runtime-only (user-layer) edit must not be able to turn
 * a failing repo green — or a passing one red on one machine only.
 *
 * `readTypedConfig` returns `descriptor.defaults` when neither file exists, so a
 * fresh checkout (before any `./singularity build` materializes the origin) still
 * validates the SEEDED defaults. That is intentional — no existence guard — and
 * it is the same answer {@link nonStaleOriginProxy} degrades a stale origin to.
 *
 * `hierarchyPath` is the config's owning-plugin path (`asPath(pluginId)`); the
 * descriptor does not carry its plugin identity, so the caller supplies it.
 */
export function readGitLayerConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F, "descriptor">,
  opts: { root: string; hierarchyPath: string },
): ConfigValues<F> {
  const gitDir = join(opts.root, "config", opts.hierarchyPath);
  return readTypedConfig(
    descriptor,
    nonStaleOriginProxy(
      descriptor as ConfigDescriptor,
      join(gitDir, `${descriptor.name}.origin.jsonc`),
    ),
    strictReadOnlyFileConfigProxy(join(gitDir, `${descriptor.name}.jsonc`)),
  );
}
