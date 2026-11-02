import { existsSync, readdirSync, readFileSync } from "fs";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  APP_SCOPE_DIR,
  configFileOwner,
  withOverrideLegend,
} from "@plugins/config_v2/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { loadConfigDescriptorsByOriginPath } from "./config-origin-gen";
import { writeGenerated } from "./write-generated";

/**
 * Re-stamp the `// @legend` block (a descriptor's `overrideLegend`) into every
 * committed override that exists for it — the base `config/<tree>/<name>.jsonc`
 * and each `@app/<id>/` fork.
 *
 * Why every build, rather than once at seeding: the legend is the only thing
 * that tells someone hand-editing an override which forms its values can take
 * (a reorder slot's spacer node, say), and nothing else keeps it there — the
 * runtime writer re-serializes the document without comments, and an author
 * deletes what they don't need today. An override that lacks it reads as "a
 * slot is a flat list of ids", and that reading is how an agent ends up
 * defining a second slot for the items it wanted on the other end of the row.
 *
 * Never creates a file (seeding owns that) and never mints a marker, so it is
 * safe in the shared repo-tree pipeline that push's normalize step also runs.
 * A hashless override is left alone: it is corrupt, and `config-origins-in-sync`
 * reports it by name.
 */
export async function applyOverrideLegends(opts: {
  configDir: AppPath;
  descriptorsByOriginRel: Map<string, ConfigDescriptor>;
}): Promise<string[]> {
  const stamped: string[] = [];
  for (const [originRel, descriptor] of opts.descriptorsByOriginRel) {
    const legend = descriptor.overrideLegend;
    if (!legend) continue;
    const owner = configFileOwner(originRel);
    if (!owner) {
      throw new Error(
        `applyOverrideLegends: cannot resolve the owning descriptor path of "${originRel}".`,
      );
    }
    const candidates = [
      owner.hier ? `${owner.hier}/${owner.name}.jsonc` : `${owner.name}.jsonc`,
    ];
    const appDir = joinAppPath(opts.configDir, owner.hier, APP_SCOPE_DIR);
    if (existsSync(appDir)) {
      for (const entry of readdirSync(appDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        candidates.push(
          `${owner.hier}/${APP_SCOPE_DIR}/${entry.name}/${owner.name}.jsonc`,
        );
      }
    }
    for (const rel of candidates) {
      const file = joinAppPath(opts.configDir, rel);
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, "utf8");
      if (!raw.startsWith("// @hash ")) continue;
      const next = withOverrideLegend(raw, legend);
      if (next === raw) continue;
      await writeGenerated({ file, content: next });
      stamped.push(rel);
    }
  }
  return stamped;
}

/** Re-stamp every override legend under `<root>/config`. */
export async function stampOverrideLegends(opts: {
  root: AppPath;
}): Promise<void> {
  await applyOverrideLegends({
    // `root`: the checkout root the caller works in.
    configDir: joinAppPath(opts.root, "config"),
    descriptorsByOriginRel: await loadConfigDescriptorsByOriginPath({
      root: opts.root,
    }),
  });
}
