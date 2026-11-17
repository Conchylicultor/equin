import { gatewayPortSync } from "@plugins/infra/plugins/launcher/plugins/gateway-port/data-dirs";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { downloadedFile } from "@plugins/infra/plugins/deps/plugins/download/deps";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import {
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  fileReportFromProcess,
  mergeBaseWithMain,
} from "@plugins/reports/plugins/outbox/plugins/file/core";
import {
  BLOCKED_ARTIFACT_URL_KIND,
  blockedArtifactUrlMessage,
  compileGenericRules,
  DefaultRulesetsSchema,
  matchingRules,
  stableServedPath,
  type BlockedArtifactUrlPayload,
} from "@plugins/framework/plugins/tooling/plugins/web-artifacts/plugins/blocker-scan/core";
import {
  blockerRulesets,
  DEFAULT_RULESETS_FILE,
} from "@plugins/framework/plugins/tooling/plugins/web-artifacts/plugins/blocker-scan/deps";
import {
  releaseDist,
  servedNamespaceDist,
  sourceOf,
  type ServedDist,
  type SourceOf,
} from "./internal/served-urls";

/**
 * The origins our paths are requested from: the public site and main's
 * namespace on this account's gateway.
 */
function origins(): string[] {
  return [
    "https://equin.ai",
    namespaceUrl(MAIN_WORKTREE_NAME, "", gatewayPortSync()),
  ];
}

/** Every dist main serves or ships: its namespace's dist and each release dist it built. */
function mainDists(): ServedDist[] {
  const dists = [
    servedNamespaceDist(worktreeArtifacts.webDist(MAIN_WORKTREE_NAME)),
  ];
  const releases = join(worktreeDataDir(MAIN_WORKTREE_NAME), "release-web");
  if (existsSync(releases)) {
    // `<composition>` links its `.live.<pid>` tree (walked once, by real
    // path); a `.staging.` / `.swap.` / `.old.` one is a publish in flight.
    const seen = new Set<string>();
    for (const name of readdirSync(releases)) {
      if (name.startsWith(".") || /\.(staging|swap|old)\./.test(name)) continue;
      const real = realpathSync(join(releases, name));
      if (seen.has(real)) continue;
      seen.add(real);
      dists.push(releaseDist(real));
    }
  }
  return dists;
}

/** One scan: rules, URLs, hits — printed, and filed unless `--dry-run`. */
const run: CliAction<[], { dryRun?: boolean }> = async (opts) => {
  const ready = await ensureDep(blockerRulesets, cliExecContext());
  const data = DefaultRulesetsSchema.parse(
    JSON.parse(
      readFileSync(downloadedFile(ready, DEFAULT_RULESETS_FILE), "utf8"),
    ),
  );
  const { rules, uncompiled } = compileGenericRules(data.rulesets);
  console.log(
    `${data.source}: ${rules.length} generic block / redirect rules from ${data.rulesets.map((r) => r.id).join(", ")}`,
  );
  for (const u of uncompiled) {
    console.log(
      `  not checked: ${u.ruleset} #${u.id} ${u.filter} — JS cannot compile it (${u.error})`,
    );
  }

  const metaMemo = new Map();
  const requestOrigins = origins();
  const hits = new Map<string, BlockedArtifactUrlPayload>();
  let urls = 0;
  let gone = 0;
  for (const dist of mainDists()) {
    console.log(`${dist.dir}: ${dist.files.length} served paths`);
    for (const served of dist.files) {
      urls++;
      const matched = new Map<string, (typeof rules)[number]>();
      for (const origin of requestOrigins) {
        for (const r of matchingRules(
          rules,
          origin + served.path,
          served.path,
        )) {
          matched.set(`${r.ruleset}#${r.id}`, r);
        }
      }
      if (matched.size === 0) continue;
      const source: SourceOf = sourceOf(served, REPO_ROOT, metaMemo);
      if (source.kind === "gone") {
        // An artifact of a source this checkout no longer has: the next
        // build of main replaces it. Said, never filed.
        gone++;
        console.log(
          `  ${served.path}: matched, but ${source.guess} is gone from this checkout (an older build's file) — not filed`,
        );
        continue;
      }
      const sourcePath = source.kind === "source" ? source.path : null;
      for (const r of matched.values()) {
        const key = `${sourcePath ?? stableServedPath(served.path)}|${r.ruleset}#${r.id}`;
        const prev = hits.get(key);
        if (prev !== undefined) {
          prev.matchedUrls++;
          continue;
        }
        hits.set(key, {
          url: served.path,
          source: sourcePath,
          ruleset: r.ruleset,
          ruleId: r.id,
          filter: r.filter,
          matchedUrls: 1,
          rulesFrom: data.source,
        });
      }
    }
  }
  console.log(
    `checked ${urls} served paths: ${hits.size} hit(s)${gone > 0 ? `, ${gone} on files gone from this checkout` : ""}`,
  );
  if (hits.size === 0) return;

  const base = await mergeBaseWithMain(REPO_ROOT);
  if (!base.ok) console.log(`  filing without staleness data: ${base.reason}`);
  let failed = 0;
  for (const hit of hits.values()) {
    const message = blockedArtifactUrlMessage(hit);
    console.log(`  HIT ${message}`);
    if (opts.dryRun === true) continue;
    const outcome = await fileReportFromProcess({
      kind: BLOCKED_ARTIFACT_URL_KIND,
      message,
      data: hit,
      // A renamed source drops the report at the drain: main fixed it since.
      ...(base.ok && hit.source !== null
        ? { code: { mergeBase: base.mergeBase, paths: [hit.source] } }
        : {}),
    });
    if (outcome.outcome !== "written") failed++;
  }
  if (failed > 0) {
    throw new Error(
      `${failed} of ${hits.size} blocker-scan report(s) could not be written to the report outbox (see the lines above)`,
    );
  }
};

export default run;
