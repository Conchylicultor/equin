import type { Check, RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import {
  currentRecordStore,
  outsideFilesAt,
  scanFilesCached,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { iconManifestPath } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { relative } from "path";
import type { IconMarker } from "@plugins/ui/plugins/icons/plugins/icon-uses/core";
import { iconUsesScan } from "./icon-uses.scan";

const LISTS: Record<IconMarker, "symbols" | "brands" | "seti"> = {
  symbol: "symbols",
  brand: "brands",
  seti: "seti",
};

/**
 * The names the committed manifest lists, read from its text — not imported:
 * the CLI process may have regenerated it after loading, and an import would
 * read the copy frozen at load (the same reason the manifest is not in core/).
 * Throws when a list is missing: a manifest this reader no longer understands
 * must fail the check, never pass it as empty.
 */
export function parseManifestLists(
  text: string,
): Record<"symbols" | "brands" | "seti", ReadonlySet<string>> {
  const list = (key: string): ReadonlySet<string> => {
    const m = new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`).exec(text);
    if (m === null) {
      throw new Error(`the icon manifest has no \`${key}\` list`);
    }
    return new Set(
      [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
        (x) => JSON.parse(`"${x[1]!}"`) as string,
      ),
    );
  };
  return {
    symbols: list("symbols"),
    brands: list("brands"),
    seti: list("seti"),
  };
}

/**
 * The files the cross-check reads, chosen on its own terms (not the
 * generator's plugin walk, so a file that walk skips is still seen): every
 * tracked `.ts` / `.tsx` under `plugins/` but declarations, generated files
 * and test code (which ships no sprite).
 */
function shippedSources(repo: RepoFiles): string[] {
  return repo
    .under("plugins")
    .filter(
      (rel) =>
        /\.tsx?$/.test(rel) &&
        !rel.endsWith(".d.ts") &&
        !rel.endsWith(".generated.ts") &&
        !isTestCodePath(rel.split("/")),
    );
}

/**
 * Independent oracle for the icon manifest. `icons:manifest-in-sync` compares
 * the committed manifest to a re-run of its generator, so a generator bug is on
 * both sides and passes (conv-1794354745-34vama: `...symbol("progress-activity")`
 * was dropped and drew an empty box). This check reads every icon use through
 * ESLint's scope analysis — the reader the icons lint rules use
 * (`iconUsesIn`) — and fails on any name the committed manifest does not list.
 */
export const manifestCoversUses: Check = {
  id: "icons:manifest-covers-uses",
  description:
    "every symbol()/brand()/seti() literal ESLint's scope analysis sees is in the committed icon manifest (an oracle independent of the manifest generator)",
  async run(ctx) {
    const repo = await ctx.repo();
    const file = iconManifestPath(repo.root);
    const rel = relative(repo.root, file);
    const text = await repo.read(rel);
    if (text === null) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./equin build` to generate it.",
      };
    }
    const manifest = parseManifestLists(text);
    const files = shippedSources(repo);
    const uses = await scanFilesCached(
      {
        snapshot: repo,
        store: currentRecordStore(),
        readOutside: outsideFilesAt(repo.root),
      },
      files,
      iconUsesScan,
    );
    const missing: string[] = [];
    files.forEach((path, i) => {
      for (const use of uses[i]!) {
        if (manifest[LISTS[use.marker]].has(use.name)) continue;
        missing.push(`${use.marker}("${use.name}") at ${path}:${use.line}`);
      }
    });
    if (missing.length > 0) {
      return {
        ok: false,
        message: `${missing.length} icon use(s) are not in ${rel}, so their sprite has no symbol for them:\n${missing.join("\n")}`,
        hint: "Run `./equin build`. If the regenerated manifest still lacks them, the manifest scan (codegen/core/icon-manifest.scan.ts) misreads these calls — fix the scan, not this check.",
      };
    }
    return { ok: true };
  },
};
