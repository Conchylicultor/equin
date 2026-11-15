import { rm, writeFile } from "node:fs/promises";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { z } from "zod";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { githubReleaseDownload } from "@plugins/infra/plugins/deps/plugins/download/deps";
import {
  DnrRuleSchema,
  type DefaultRulesets,
} from "@plugins/framework/plugins/tooling/plugins/web-artifacts/plugins/blocker-scan/core";
import pin from "./ubol-rulesets.pin.json";

/** The derived file the scan reads: every default-on ruleset's cancelling rules. */
export const DEFAULT_RULESETS_FILE = "default-rulesets.json";

const ZIP = "ubol.zip";

/** uBO Lite's ruleset index: which rulesets exist and which it turns on out of the box. */
const RulesetDetailsSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean().optional(),
    })
    .passthrough(),
);

/**
 * uBlock Origin Lite's rulesets — EasyList, EasyPrivacy, uBlock filters and
 * the rest, compiled to Chrome's declarativeNetRequest rules — from its
 * Chromium release zip on GitHub. Fetched on demand into the deps cache and
 * never committed: the lists are GPLv3 / CC BY-SA, this repo is Apache-2.0.
 * The `github-release` updater moves the pin (`ubol-rulesets.pin.json`) to each
 * new uBO Lite release past its cooldown.
 *
 * The derive keeps only what the scan asks about: the rulesets uBO Lite
 * enables by default (`ruleset-details.json`'s `enabled`), each with its
 * block and redirect rules (`rulesets/main/<id>.json` + `rulesets/regex/<id>.json`).
 */
export const blockerRulesets = defineDep({
  id: "blocker-rulesets",
  owner: "framework/tooling/web-artifacts/blocker-scan",
  description:
    "uBlock Origin Lite's default-on content-blocker rulesets (EasyList, EasyPrivacy, uBlock filters…), checked against every URL main serves",
  sizeHint: "≈9 MB download, ≈4 MB installed",
  source: githubReleaseDownload({
    name: ZIP,
    pin,
    pinFile:
      "plugins/framework/plugins/tooling/plugins/web-artifacts/plugins/blocker-scan/deps/internal/ubol-rulesets.pin.json",
    derive: {
      version: "1",
      outputs: [DEFAULT_RULESETS_FILE],
      async run(ctx) {
        const extract = join(ctx.dir, "extract");
        await ctx.run(
          [
            "unzip",
            "-q",
            "-o",
            join(ctx.dir, ZIP),
            "rulesets/ruleset-details.json",
            "rulesets/main/*.json",
            "rulesets/regex/*.json",
            "-d",
            extract,
          ],
          { cwd: ctx.dir, env: { ...process.env }, timeoutMs: 5 * 60_000 },
        );
        const details = RulesetDetailsSchema.parse(
          JSON.parse(
            await readFile(
              join(extract, "rulesets", "ruleset-details.json"),
              "utf8",
            ),
          ),
        );
        const enabled = details.filter((d) => d.enabled === true);
        if (enabled.length === 0) {
          throw new Error(
            "uBO Lite's ruleset-details.json enables no ruleset by default — its format changed",
          );
        }
        const out: DefaultRulesets = {
          source: `uBlock Origin Lite ${pin.tag}`,
          rulesets: [],
        };
        for (const d of enabled) {
          const rules = [];
          for (const kind of ["main", "regex"]) {
            const file = join(extract, "rulesets", kind, `${d.id}.json`);
            if (!(await exists(file))) continue;
            const parsed = z
              .array(DnrRuleSchema)
              .parse(JSON.parse(await readFile(file, "utf8")));
            rules.push(
              ...parsed.filter(
                (r) =>
                  r.action.type === "block" || r.action.type === "redirect",
              ),
            );
          }
          out.rulesets.push({ id: d.id, name: d.name, rules });
          ctx.log(`${d.id}: ${rules.length} block / redirect rules`);
        }
        await writeFile(
          join(ctx.dir, DEFAULT_RULESETS_FILE),
          JSON.stringify(out),
        );
        await rm(extract, { recursive: true, force: true });
        await rm(join(ctx.dir, ZIP), { force: true });
      },
    },
  }),
});
