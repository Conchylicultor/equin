import {
  TESTS_DIR,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  findMarkerCalls,
  lineAt,
  maskSource,
  matchBracket,
  parseStringField,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

// The pure half of durable-signals-accounted: find every durable-sink
// declaration in a set of sources, and fold the resolved call sites into the
// sink-id map the check validates. No git, no fs — the check feeds it sources
// from listCandidateSources and resolves `const` names itself — so every rule
// here (which calls count, what a computed id means, when two primitives claim
// one id, how a call's `consumer` classification reads) is unit-testable on
// literal strings.

/**
 * The two ways a durable sink comes into existence. `defineLogSink` is the
 * server's log channel (a registry entry + a file sink); `defineFileSink` is
 * the bare bounded file, the only form a CLI process can use. Both write a file
 * that outlives the process, so both must be accounted.
 */
export const SINK_MARKERS = ["defineLogSink", "defineFileSink"] as const;
export type SinkMarker = (typeof SINK_MARKERS)[number];

/**
 * Where declarations are looked for. Tests are excluded: a test's sink is a
 * throwaway under a tmp dir with a generated id (`id: uniqueId()`), never a
 * durable signal anyone reads.
 */
export const SINK_PATHSPECS = [
  "*.ts",
  "*.tsx",
  ":(exclude)*.test.ts",
  ":(exclude)*.test.tsx",
  `:(exclude)**/${TESTS_DIR}/**`,
  `:(exclude)**/${TESTING_FOLDER}/**`,
];

// A call site whose id is computed ON PURPOSE (its ids already accounted
// elsewhere) is exempted in the owning plugin's `exempt/index.ts`, rule
// `durable-signals-accounted`; the runner fails a stale one.

/** How a string field (`id`, `reportKind`, `timelineSource`) reads before const resolution. */
export type RawStringRef =
  | { kind: "literal"; value: string }
  /** A bare identifier (`id: DURESS_EPISODES_CHANNEL`) — resolvable to its `export const`. */
  | { kind: "const"; name: string }
  /** Anything else: a member access, a call, a template, a shorthand, or no field at all. */
  | { kind: "computed"; expr: string | null };

/**
 * How a call's `consumer` classification reads. Its kind/note shape is tsc's
 * job (`SinkConsumer`); the check only needs the two cross-plugin references,
 * and it can only read them from an INLINE object literal — `consumer: X`
 * would let a classification dodge validation, so it is `opaque` and fails.
 */
export type RawConsumer =
  | {
      kind: "inline";
      reportKind: RawStringRef | null;
      timelineSource: RawStringRef | null;
    }
  | { kind: "opaque"; expr: string | null };

export interface RawSinkCall {
  marker: SinkMarker;
  path: string;
  line: number;
  id: RawStringRef;
  consumer: RawConsumer;
}

export interface ResolvedSinkCall {
  marker: SinkMarker;
  path: string;
  line: number;
  /** Null when the id is computed, or a const with no live declaration. */
  id: string | null;
}

export interface CallSite {
  marker: SinkMarker;
  path: string;
  line: number;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function readStringRef(src: string, field: string): RawStringRef {
  const res = parseStringField(src, field);
  if (res.kind === "value") return { kind: "literal", value: res.value };
  if (res.kind === "dynamic" && IDENTIFIER.test(res.expr.trim())) {
    return { kind: "const", name: res.expr.trim() };
  }
  return { kind: "computed", expr: res.kind === "dynamic" ? res.expr : null };
}

/**
 * Read the `consumer` field of a call's args. Masked first, so a `consumer:`
 * inside a note string or comment never matches; the object is sliced from the
 * ORIGINAL by bracket match, so its fields read back intact.
 */
export function readConsumer(argsText: string): RawConsumer {
  const masked = maskSource(argsText);
  const m = /\bconsumer\s*:\s*/.exec(masked);
  if (!m) return { kind: "opaque", expr: null };
  const at = m.index + m[0].length;
  if (masked[at] !== "{") {
    const expr = /^[^,}]*/.exec(masked.slice(at))?.[0].trim() ?? "";
    return { kind: "opaque", expr };
  }
  const close = matchBracket(masked, at, "{", "}");
  if (close < 0) return { kind: "opaque", expr: null };
  const body = argsText.slice(at, close + 1);
  const field = (name: string): RawStringRef | null =>
    parseStringField(body, name).kind === "absent"
      ? null
      : readStringRef(body, name);
  return {
    kind: "inline",
    reportKind: field("reportKind"),
    timelineSource: field("timelineSource"),
  };
}

/**
 * Every declaration of `marker` in `sources`. Detection is AST-shaped, not
 * line-based: `findMarkerCalls` full-masks (a call written in a comment or a
 * string never matches) and slices the args from the original, so the `id`
 * field reads back intact whatever the call's line layout.
 */
export function scanSinkCalls(
  sources: ReadonlyArray<{ rel: string; src: string }>,
  marker: SinkMarker,
): RawSinkCall[] {
  const calls: RawSinkCall[] = [];
  for (const { rel, src } of sources) {
    for (const call of findMarkerCalls(src, marker)) {
      // Skip the primitive's OWN definition (`export function defineFileSink(spec:
      // FileSinkSpec)`): a real declaration passes an inline object literal, so
      // its args begin with `{`; a signature's begin with a parameter name.
      if (!/^\s*\{/.test(call.argsText)) continue;
      calls.push({
        marker,
        path: rel,
        line: lineAt(src, call.index),
        id: readStringRef(call.argsText, "id"),
        consumer: readConsumer(call.argsText),
      });
    }
  }
  return calls;
}

export interface SinkInventory {
  /** Computed / unresolvable ids NOT excused by `skips`. */
  unresolvable: CallSite[];
  /** One id declared through BOTH primitives. */
  collisions: Array<{ id: string; sites: CallSite[] }>;
}

/**
 * Fold resolved call sites into the inventory. The same id declared twice
 * through ONE primitive is left to the runtime registry (which rejects a real
 * duplicate); the same id through BOTH primitives is a collision
 * — two different sinks claiming one file-sink id — and is reported.
 */
export function inventorySinks(
  calls: readonly ResolvedSinkCall[],
  skips: (path: string) => boolean,
): SinkInventory {
  const byMarker = new Map<string, Map<SinkMarker, CallSite>>();
  const unresolvable: CallSite[] = [];

  for (const call of calls) {
    const site: CallSite = {
      marker: call.marker,
      path: call.path,
      line: call.line,
    };
    if (call.id === null) {
      // Only a computed id is ever offered to `skips`, so an exemption that
      // never meets one is reported unused by the runner.
      if (!skips(call.path)) unresolvable.push(site);
      continue;
    }
    let markers = byMarker.get(call.id);
    if (!markers) byMarker.set(call.id, (markers = new Map()));
    if (!markers.has(call.marker)) markers.set(call.marker, site);
  }

  const collisions = [...byMarker]
    .filter(([, markers]) => markers.size > 1)
    .map(([id, markers]) => ({ id, sites: [...markers.values()] }));
  return { unresolvable, collisions };
}
