import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { APP_SCOPE_DIR, type ConfigDescriptor } from "@plugins/config_v2/core";
import {
  configTextHash,
  parseConfigText,
  rewriteConfigFiles,
  runConfigLedger,
  unappliedLedgerKeys,
  walkConfigFiles,
} from "./config-ledger";

/** Per-namespace record of the config migrations already applied. */
export const APPLIED_CONFIG_MIGRATIONS_FILE = ".config-migrations-applied.json";

export interface AppliedConfigMigration {
  /** `<hierarchy path>/<config name>:<migration id>` — the ledger key. */
  key: string;
  /** Files the migration (or the hash re-stamp it caused) rewrote. */
  rewritten: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const migrationKey = (
  hierarchyPath: string,
  descriptor: ConfigDescriptor,
  id: string,
) => `${hierarchyPath}/${descriptor.name}:${id}`;

/** Whether the namespace has saved config at all (a fresh one records migrations without running them). */
const isFresh = (userConfigDir: AppPath) =>
  !walkConfigFiles(userConfigDir).some((f) => f.endsWith(".jsonc"));

/**
 * Whether `applyConfigMigrations` would RUN a migration's `apply` on this
 * namespace — an unapplied migration and saved config to rewrite. A caller
 * holding descriptors read from plugin records (whose functions are stubs)
 * must hand `applyConfigMigrations` live descriptors when this is true.
 */
export function configMigrationsPending(opts: {
  userConfigDir: AppPath;
  configs: readonly { hierarchyPath: string; descriptor: ConfigDescriptor }[];
}): boolean {
  const keys = opts.configs.flatMap(({ hierarchyPath, descriptor }) =>
    (descriptor.migrations ?? []).map((m) =>
      migrationKey(hierarchyPath, descriptor, m.id),
    ),
  );
  return (
    unappliedLedgerKeys({
      userConfigDir: opts.userConfigDir,
      markerFile: APPLIED_CONFIG_MIGRATIONS_FILE,
      keys,
    }).length > 0 && !isFresh(opts.userConfigDir)
  );
}

/**
 * Apply every config migration (`defineConfigMigration`, declared on a
 * descriptor's `migrations`) that the namespace dir `userConfigDir` has not
 * applied yet: each one rewrites that config's origin, override and ancestor
 * documents — base scope and every `@app/<id>` scope — through its `apply`,
 * with the hash chain kept (the shared config ledger). A namespace with no
 * saved config yet records them all without running.
 */
export function applyConfigMigrations(opts: {
  userConfigDir: AppPath;
  configs: readonly { hierarchyPath: string; descriptor: ConfigDescriptor }[];
}): AppliedConfigMigration[] {
  const { userConfigDir, configs } = opts;
  const fresh = isFresh(userConfigDir);
  const entries = configs.flatMap(({ hierarchyPath, descriptor }) => {
    const files = new RegExp(
      `^${escapeRe(hierarchyPath)}/(${escapeRe(APP_SCOPE_DIR)}/[^/]+/)?${escapeRe(descriptor.name)}(\\.origin|\\.ancestor)?\\.jsonc$`,
    );
    return (descriptor.migrations ?? []).map((migration) => ({
      key: migrationKey(hierarchyPath, descriptor, migration.id),
      apply: (dir: AppPath): string[] =>
        rewriteConfigFiles(dir, {
          select: (rel) => files.test(rel),
          rewrite: (rel, text) => {
            const before = parseConfigText(rel, text);
            const after = migration.apply(before);
            if (JSON.stringify(after) === JSON.stringify(before)) return text;
            const hash = configTextHash(text);
            return `${hash === undefined ? "" : `// @hash ${hash}\n`}${JSON.stringify(after, null, 2)}\n`;
          },
        }),
    }));
  });
  return runConfigLedger({
    userConfigDir,
    markerFile: APPLIED_CONFIG_MIGRATIONS_FILE,
    fresh,
    entries,
  }).map(({ key, result }) => ({ key, rewritten: result }));
}
