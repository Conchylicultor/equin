import type TS from "typescript";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { segmentCollision } from "../core";
import identityManifestCheck from "./identity-manifest";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

// `typescript`'s module object is invariant for the process's lifetime — not a
// tree-derived fact — so a per-process memo is safe. Loaded lazily so this
// module's own top-level import doesn't pay `typescript`'s eval cost during the
// check runner's "load all checks" burst, well before any check's `run()` starts.
let tsPromise: Promise<typeof TS> | undefined;
function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

interface SegmentSite {
  raw: string;
  file: string;
  line: number;
}

function literalText(ts: typeof TS, node: TS.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

// The call expressions whose first-argument object literal authors a pane's URL
// segment. There is exactly one: `defineRoute({ ... })`. `Pane.define` takes its
// identity from the `RouteDef` it is handed and declares no `segment` field of
// its own, so `Pane.define({ segment })` has no spelling to scan for.
function isSegmentDefiningCall(
  ts: typeof TS,
  node: TS.CallExpression,
): boolean {
  const callee = node.expression;
  return ts.isIdentifier(callee) && callee.text === "defineRoute";
}

function collectSegments(
  ts: typeof TS,
  file: string,
  source: string,
): SegmentSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: SegmentSite[] = [];

  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isSegmentDefiningCall(ts, node) &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0]!)
    ) {
      for (const prop of node.arguments[0]!.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "segment"
        ) {
          const raw = literalText(ts, prop.initializer);
          // Non-literal segments can't be analyzed statically; in practice every
          // segment is a string literal (the runtime check is the backstop).
          if (raw === null) break;
          const line =
            sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1;
          sites.push({ raw, file, line });
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

const check: Check = {
  id: "pane:segments-unique",
  description:
    "pane URL segments must be globally unique (no two panes match the same URLs)",
  async run() {
    const ts = await loadTypescript();
    // Files that may author a pane segment: any source calling `defineRoute`,
    // which is the only place a segment is written. Tests are excluded — they
    // register throwaway panes that never ship.
    const sources = await listCandidateSources({
      grepArg: "defineRoute",
      pathspecs: [
        "plugins/**/*.ts",
        "plugins/**/*.tsx",
        ":(exclude)**/*.test.ts",
        ":(exclude)**/*.test.tsx",
      ],
    });

    const sites = sources.flatMap(({ rel, src }) =>
      collectSegments(ts, rel, src),
    );
    // Every pair, not a shape index: a wildcard (`at/:url*`) matches URLs of
    // many shapes, so two segments collide without sharing one
    // (`segmentCollision`). Index/empty-segment panes (`""`, or keyed-only
    // `";page"`) match no URL, so they never collide — multiple are legal
    // (mirrors useSyncPaneRegistry).
    const collisions: Array<[string, SegmentSite[]]> = [];
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const url = segmentCollision(sites[i]!.raw, sites[j]!.raw);
        if (url !== null) collisions.push([url, [sites[i]!, sites[j]!]]);
      }
    }
    if (collisions.length === 0) return { ok: true };

    const message =
      `${collisions.length} pane segment collision(s) — these match the same URLs:\n` +
      collisions
        .map(
          ([pattern, sites]) =>
            `  ${pattern}\n` +
            sites.map((s) => `    ${s.file}:${s.line}  "${s.raw}"`).join("\n"),
        )
        .join("\n");

    return {
      ok: false,
      message,
      hint:
        "Pane segments (and route segments) must be globally unique — param " +
        "names don't disambiguate (`r/:runId` and `r/:reportId` both match " +
        "`r/<x>`), and a wildcard `:rest*` swallows every longer URL under " +
        "its prefix (`at/:url*` takes `at/<dir>`). Rename one segment's " +
        "static prefix to a distinct value. " +
        "Left unfixed, this throws at runtime on navigation.",
    };
  },
};

// One check per file, aggregated here — the `check/` contract is `Check |
// Check[]`, so a second invariant about panes is a sibling file, not a second
// plugin.
export default [check, identityManifestCheck];
