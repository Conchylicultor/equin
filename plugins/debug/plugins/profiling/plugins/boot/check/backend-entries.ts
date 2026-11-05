import type {
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";

/** The serving backend's composition root. */
export const BIN_ENTRY = "plugins/framework/plugins/server-core/bin/index.ts";
// eslint-disable-next-line exempt/no-path-allowlist -- the registries whose members a backend boots, not an allowlist of violators
const REGISTRIES = [
  "plugins/framework/plugins/server-core/core/server.generated.ts",
  "plugins/framework/plugins/server-core/core/machine.generated.ts",
];
/** A registry entry: `import("@plugins/<path>/<runtime>")`. */
const ENTRY_RE = /import\("@plugins\/([^"]+)"\)/g;

/**
 * What a backend boots: its bin plus every server and machine barrel the
 * registries list (the bin reaches the registries by a computed path, so a
 * closure measured from the bin alone stops there). A failed result when a
 * registry or a barrel it names is missing — a build is due.
 */
export async function backendEntries(
  repo: RepoFiles,
): Promise<
  { ok: true; entries: string[] } | { ok: false; result: CheckResult }
> {
  const entries = [BIN_ENTRY];
  for (const registry of REGISTRIES) {
    const src = await repo.read(registry);
    if (src === null) {
      return {
        ok: false,
        result: {
          ok: false,
          message: `${registry} is missing — run ./equin build`,
        },
      };
    }
    for (const m of src.matchAll(ENTRY_RE)) {
      const dir = `plugins/${m[1]}`;
      const barrel = [`${dir}/index.ts`, `${dir}/index.tsx`].find((f) =>
        repo.has(f),
      );
      if (barrel === undefined) {
        return {
          ok: false,
          result: {
            ok: false,
            message: `${registry} names ${dir}, which has no index.ts — run ./equin build`,
          },
        };
      }
      entries.push(barrel);
    }
  }
  return { ok: true, entries };
}
