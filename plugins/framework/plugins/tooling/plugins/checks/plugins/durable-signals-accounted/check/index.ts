import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  grepCode,
  listCandidateSources,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  findMarkerCalls,
  parseStringField,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { TIMELINE_SOURCES } from "@plugins/debug/plugins/timeline/core";
import {
  SINK_MARKERS,
  SINK_PATHSPECS,
  inventorySinks,
  scanSinkCalls,
  type CallSite,
  type RawConsumer,
  type RawStringRef,
  type ResolvedSinkCall,
  type SinkInventory,
} from "./scan";

// Every DURABLE sink — a `defineLogSink` log channel or a bare `defineFileSink`
// file — carries a required `consumer` classification at its declaration
// (`SinkConsumer`, file-sink/core: tsc forces the decision). The 2026-07-17
// incident's root cause was a durable failure signal (an 11.5-minute
// never-ready boot on the `boot` channel) that reached NO alert funnel — it was
// persisted and then consumed by nothing.
//
// The primitive keeps `reportKind` / `timelineSource` as opaque strings (it
// must never name reports or the timeline), so this check validates what tsc
// cannot see: every report classification names a live ReportKind, every
// timeline classification a TIMELINE_SOURCES member, and the classification is
// an inline object literal it can actually read.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolve a const-named sink id (`export const NAME = "value"`) to its string
// value. maskStrings:false keeps the string literal readable while comments stay
// masked (so a commented-out declaration can't resolve it). Null when no live
// declaration is found.
async function resolveConst(
  root: string,
  name: string,
): Promise<string | null> {
  const hits = await grepCode({
    root,
    grepArg: name,
    fixed: true,
    pattern: new RegExp(
      `export\\s+const\\s+${escapeRegExp(name)}\\s*=\\s*["'][^"']+["']`,
    ),
    maskStrings: false,
  });
  for (const hit of hits) {
    const vm = /=\s*["']([^"']+)["']/.exec(hit.text);
    if (vm?.[1] !== undefined) return vm[1];
  }
  return null;
}

// The set of report kinds with a live `ReportKind({ kind: "..." })` call site.
// listCandidateSources is scan-tree + untracked aware (so a just-added kind is
// seen); findMarkerCalls full-masks (a `ReportKind(...)` written inside a
// comment or string can never match) and slices the args from the ORIGINAL, so
// the `kind` value is read back intact via parseStringField. A bare identifier
// (`kind: DB_QUERY_DEADLINE_KIND`, the single-sourced-kind-string convention)
// is resolved to its `export const` value, exactly like a sink id.
async function registeredReportKinds(root: string): Promise<Set<string>> {
  const sources = await listCandidateSources({
    root,
    grepArg: "ReportKind",
    fixed: true,
  });
  const kinds = new Set<string>();
  for (const { src } of sources) {
    for (const call of findMarkerCalls(src, "ReportKind")) {
      const res = parseStringField(call.argsText, "kind");
      if (res.kind === "value") kinds.add(res.value);
      else if (
        res.kind === "dynamic" &&
        /^[A-Za-z_$][\w$]*$/.test(res.expr.trim())
      ) {
        const value = await resolveConst(root, res.expr.trim());
        if (value !== null) kinds.add(value);
      }
    }
  }
  return kinds;
}

// Discover every durable-sink declaration, through BOTH primitives
// (defineLogSink and defineFileSink). The scan and the fold are the pure
// helpers in ./scan; this only feeds them sources and resolves `const` ids
// (`id: DURESS_EPISODES_CHANNEL`) to their declared string values.
interface ClassifiedSite {
  id: string;
  site: CallSite;
  consumer: RawConsumer;
}

async function resolveRef(
  root: string,
  ref: RawStringRef,
): Promise<string | null> {
  if (ref.kind === "literal") return ref.value;
  if (ref.kind === "const") return await resolveConst(root, ref.name);
  return null;
}

async function findDurableSinks(
  root: string,
  skips: (path: string) => boolean,
): Promise<SinkInventory & { classified: ClassifiedSite[] }> {
  const resolved: ResolvedSinkCall[] = [];
  const classified: ClassifiedSite[] = [];
  for (const marker of SINK_MARKERS) {
    const sources = await listCandidateSources({
      root,
      grepArg: marker,
      fixed: true,
      pathspecs: SINK_PATHSPECS,
    });
    for (const call of scanSinkCalls(sources, marker)) {
      const id = await resolveRef(root, call.id);
      const site = { marker: call.marker, path: call.path, line: call.line };
      resolved.push({ ...site, id });
      // A computed id is exempted wholesale (its classification is forwarded
      // from a call site scanned here) or already fails as unresolvable.
      if (id !== null) classified.push({ id, site, consumer: call.consumer });
    }
  }
  return { ...inventorySinks(resolved, skips), classified };
}

const fmtSite = (s: CallSite): string => `${s.path}:${s.line} (${s.marker})`;

const check: Check = {
  id: "durable-signals-accounted",
  description:
    "Every durable sink (defineLogSink channel or defineFileSink file) declares its consumer as an inline object, and every report/timeline classification points at a live ReportKind / TimelineSource",
  exemptable: {
    "durable-signals-accounted":
      "computes a durable sink's id on purpose (its ids are accounted elsewhere), so the check cannot name it",
  },
  async run(ctx) {
    const root = await getWorktreeRoot();
    const exempt = await ctx.exempt("durable-signals-accounted");
    const { unresolvable, collisions, classified } = await findDurableSinks(
      root,
      exempt.skips,
    );

    // Loud failure: a durable sink whose id we cannot resolve. The check cannot
    // classify what it cannot name, so this is never silently skipped.
    if (unresolvable.length > 0) {
      return {
        ok: false,
        message:
          `Durable sink call site(s) with an unresolvable id ` +
          `in ${unresolvable.length} place(s):\n    ` +
          unresolvable.map(fmtSite).join("\n    "),
        hint: 'Use a string literal or an `export const NAME = "…"` for the sink id so durable-signals-accounted can name it. A computed id whose ids are genuinely accounted elsewhere declares an exemption (rule `durable-signals-accounted`) in the owning plugin\'s `exempt/index.ts`.',
      };
    }

    // Loud failure: one id declared through both primitives. They share one
    // file-sink id namespace (a log channel owns a file sink under its own id), so
    // two declarations of one id are two sinks fighting over one file.
    if (collisions.length > 0) {
      return {
        ok: false,
        message:
          `Sink id(s) declared through both defineLogSink and defineFileSink:\n    ` +
          collisions
            .map((c) => `"${c.id}": ${c.sites.map(fmtSite).join(", ")}`)
            .join("\n    "),
        hint: "A defineLogSink channel already owns a file sink under its own id. Rename one of them.",
      };
    }

    // Coherence: the classification is readable, and every cross-plugin
    // reference in it resolves. tsc already forced a report to carry a
    // reportKind and a timeline a timelineSource.
    const reportKinds = await registeredReportKinds(root);
    const timelineSources = new Set<string>(TIMELINE_SOURCES);
    const problems: string[] = [];
    for (const { id, site, consumer } of classified) {
      const at = `"${id}" (${fmtSite(site)})`;
      if (consumer.kind === "opaque") {
        const what = consumer.expr ?? "(missing)";
        problems.push(
          `${at}: consumer ${what} is not an inline object literal`,
        );
        continue;
      }
      if (consumer.reportKind !== null) {
        const kind = await resolveRef(root, consumer.reportKind);
        if (kind === null) {
          problems.push(`${at}: reportKind is not a literal or export const`);
        } else if (!reportKinds.has(kind)) {
          problems.push(
            `${at}: reportKind "${kind}" has no ReportKind({ kind: "${kind}" }) call site`,
          );
        }
      }
      if (consumer.timelineSource !== null) {
        const source = await resolveRef(root, consumer.timelineSource);
        if (source === null) {
          problems.push(
            `${at}: timelineSource is not a literal or export const`,
          );
        } else if (!timelineSources.has(source)) {
          problems.push(
            `${at}: timelineSource "${source}" is not in TIMELINE_SOURCES`,
          );
        }
      }
    }
    if (problems.length > 0) {
      return {
        ok: false,
        message:
          `Durable sink classification(s) incoherent:\n    ` +
          problems.join("\n    "),
        hint: "Write `consumer: { kind, …, note }` inline at the defineLogSink / defineFileSink call. A report names a registered ReportKind; a timeline names a TIMELINE_SOURCES member. A never-consumed durable signal is exactly the 2026-07-17 gap this check exists to prevent.",
      };
    }

    return { ok: true };
  },
};

export default check;
