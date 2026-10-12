import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  FEED_EXCLUSION_MARKER,
  NOTIFY_MARKERS,
  findFeedExclusions,
  scanDbBackedNotify,
} from "./scan";
import { ModuleIndex } from "./resolve";

const check: Check = {
  id: "no-db-backed-notify",
  description:
    'Resources whose loader reads the DB (in the call, or in a same-file or imported function it reaches) must not be served external (`defineExternalResource`, or `serveValue` with `source: "external"`), which exposes hand-`notify` — the DB change-feed is their only invalidation path. DB writes in an external loader are allowed. Exempt: a read that names (by identifier or SQL name) a table the serving plugin excludes from the feed (`ExcludeFromChangeFeed({ table: <identifier> })`), whose writer is then the only change signal.',
  exemptable: {
    "no-db-backed-notify":
      "serves a DB-reading resource external (hand-`notify`) although the change-feed can see what it reads — e.g. it reads a schema the feed deliberately excludes, which only an exemption sanctions",
  },
  async run(ctx) {
    // Fast pre-filter: candidate files mentioning either bare identifier. We
    // match the identifiers — NOT a `(`-anchored token — because a call's
    // generic form (`defineExternalResource<…>(…)`) can SPAN LINES, so a
    // per-line `(`-anchored pre-filter would miss it and wrongly drop the file.
    // The precise `<…>`-tolerant, whole-file span walk happens in the scan via
    // `markerCallSpans`. listCandidateSources reads the scan tree (untracked
    // files included), so the verdict is over the exact bytes checked.
    const sources = await listCandidateSources({
      grepArg: NOTIFY_MARKERS.join("|"),
      fixed: false,
    });
    // The exemption, derived: per plugin, the tables it excludes from the feed
    // by its own declaration (see `findFeedExclusions`).
    const exclusionSources = await listCandidateSources({
      grepArg: FEED_EXCLUSION_MARKER,
      fixed: true,
    });
    const exempt = await ctx.exempt("no-db-backed-notify");
    // Loaders defined in other files are followed through the run's file set
    // (async, gated reads — never a blocking walk).
    const repo = await ctx.repo();
    const modules = new ModuleIndex({
      has: (rel) => repo.has(rel),
      read: (rel) => repo.read(rel),
    });
    const offenders = (
      await scanDbBackedNotify(
        sources,
        await findFeedExclusions(exclusionSources, modules),
        modules,
      )
    )
      .filter((o) => !exempt.skips(o.path))
      .map(
        (o) => `${o.path}:${o.line} (${o.marker}${o.via ? ` → ${o.via}` : ""})`,
      );

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `DB-backed external resource found in ${offenders.length} place(s) (its loader — the call, or a function it reaches — reads the DB):\n    ${offenders.join("\n    ")}`,
      hint: 'A resource whose loader reads Postgres must be served from the DB arm — `serveValue(value, { source: "db", … })` (the old spelling: `defineResource`) — with no hand-`notify`, and rely on the DB change-feed for invalidation: that\'s the only path that can never miss a write. The external arm — `serveValue(value, { source: "external", … })` (the old spelling: `defineExternalResource`) — is exclusively for resources whose truth lives OUTSIDE Postgres (git/file watchers, transcript reads, in-memory registries, secrets); only those get a callable `notify`. A resource that reads a schema the feed excludes (e.g. `graphile_worker.*`) declares an exemption (rule `no-db-backed-notify`) in its plugin\'s `exempt/index.ts`.',
    };
  },
};

export default check;
