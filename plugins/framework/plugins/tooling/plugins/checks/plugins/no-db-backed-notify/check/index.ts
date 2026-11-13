import type TS from "typescript";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  listCandidateSources,
  sliceCheckThread,
  sourceAnalysis,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { formatUnreadable } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import { findFeedExclusions, scanDbBackedNotify } from "./scan";

const ID = "no-db-backed-notify";

let tsPromise: Promise<typeof TS> | undefined;
function loadTs(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

const check: Check = {
  id: ID,
  wholeTreeRead: {
    kind: "debt",
    task: "task-1794579727-rjy6wx",
    reason:
      "input-keyed, but a run reads the ~1.3k sources its use search selects",
  },
  // INPUT-KEYED: every byte the verdict reads goes through `ctx.repo()` (the
  // source analysis's files and module resolution, the exemption manifests)
  // or `listCandidateSources` (each grep selection and its candidates), both
  // recorded. So an edit to a file the analysis never read — most edits: it
  // reads ~1.5k of ~14k sources — replays the read-set and runs nothing; one
  // it read, or one that changes a selection, runs the whole analysis again.
  // Its code is covered by the check-source hash (it and source-analysis live
  // under `tooling/`); the parser's version is the signature.
  inputKeyed: true,
  async cacheSignature() {
    return `typescript@${(await loadTs()).version}`;
  },
  outOfScope: ["test"],
  description:
    'Resources whose loader reads the DB (in the call, or in any function or const it reaches, followed to its declaration across files) must not be served external (`defineExternalResource`, or `serveValue` / `serveCollection` with `source: "external"`), which exposes hand-`notify` — the DB change-feed is their only invalidation path — unless the external `serveValue` declares those reads (`reads:`), which routes it from the feed. DB writes in an external loader are allowed. Exempt: a read that names (by reference or SQL name) a table the serving plugin excludes from the feed (`ExcludeFromChangeFeed({ table: <identifier> })`), whose writer is then the only change signal. Read from the syntax tree through every alias, barrel and wrapper, fail-closed: what cannot be read is a violation.',
  exemptable: {
    [ID]: "serves a DB-reading resource external (hand-`notify`) although the change-feed can see what it reads — e.g. it reads a schema the feed deliberately excludes, which only an exemption sanctions",
  },
  async run(ctx) {
    const [ts, analysis, exempt] = await Promise.all([
      loadTs(),
      sourceAnalysis(ctx),
      ctx.exempt(ID),
    ]);
    const candidatesFor = (grepArg: string) =>
      listCandidateSources({ grepArg });
    // The exemption, derived: per plugin, the tables it excludes from the feed
    // by its own declaration (see `findFeedExclusions`).
    const exclusions = await findFeedExclusions(ts, analysis, candidatesFor);
    const { offenders, unreadable } = await scanDbBackedNotify(
      ts,
      analysis,
      candidatesFor,
      exclusions,
      { skips: (rel) => exempt.skips(rel), slice: sliceCheckThread },
    );
    if (offenders.length === 0 && unreadable.length === 0) return { ok: true };
    const lines = [
      ...offenders.map(
        (o) => `${o.path}:${o.line} (${o.marker}${o.via ? ` → ${o.via}` : ""})`,
      ),
      ...dedupe(unreadable.map((u) => `unreadable: ${formatUnreadable(u)}`)),
    ];
    return {
      ok: false,
      message: `${offenders.length} DB-backed external resource(s) (the loader — the call, or code it reaches — reads the DB), ${unreadable.length} spot(s) could not be read:\n    ${lines.join("\n    ")}`,
      hint: 'A resource whose loader reads Postgres must be served from the DB arm — `serveValue(value, { source: "db", … })` (the old spelling: `defineResource`) — with no hand-`notify`, and rely on the DB change-feed for invalidation: that\'s the only path that can never miss a write. The external arm — `serveValue(value, { source: "external", … })` (the old spelling: `defineExternalResource`) — is exclusively for resources whose truth lives OUTSIDE Postgres (git/file watchers, transcript reads, in-memory registries, secrets); only those get a callable `notify`. One whose loader ALSO reads Postgres declares those reads beside its notify: `serveValue(value, { source: "external", changes: "notified", reads: { tables, reason }, … })`. A resource that reads a schema the feed excludes (e.g. `graphile_worker.*`) declares an exemption (rule `no-db-backed-notify`) in its plugin\'s `exempt/index.ts`. An `unreadable:` line is code the check cannot follow — rewrite it as the reason says (options inline or in a `const`, a literal `source`, the serve function called directly rather than through a wrapper).',
    };
  },
};

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

export default check;
