import { lineAt, markerCallSpans } from "./find-marker-calls";
import { hasField, matchBracket, parseStringField } from "./helpers";
import { maskSource } from "./mask-source";

/**
 * How a write route decides its effect reaches the user — the arm
 * `defineEndpoint` requires (infra/endpoints `core/prediction.ts`), read from
 * source. `unpredicted` carries the stated reason, `debt` the prediction gap.
 * `undecided` is a write declaring no arm at all (the runtime refuses it; the
 * docs show it rather than hiding it).
 */
export type RoutePrediction =
  | "predicted"
  | "internal"
  | "telemetry"
  | "undecided"
  | { unpredicted: string }
  | { debt: string };

/** One `export const <name> = defineEndpoint({ route: "…", … })` of a file. */
export interface EndpointExport {
  /** The exported const's name. */
  name: string;
  /** `"<METHOD> <path>"`, as declared. */
  route: string;
  /**
   * The declaration sets `needsMachine` (any value — the feature is a runtime
   * object): only the desktop app's own server serves it.
   */
  needsMachine: boolean;
  /** 1-based line of the `defineEndpoint` call. */
  line: number;
  /** The write's prediction decision; absent for a read (GET). */
  prediction?: RoutePrediction;
}

/**
 * Every endpoint a file declares, read from its source text (never evaluated)
 * — the one reading of an endpoint declaration, shared by the `routes` docs
 * facet (an `httpRoutes` computed key `[x.route]` → its route string) and the
 * browser-host coverage guard (which endpoints a scoped page calls, and which
 * of them only the computer serves).
 *
 * FULL-masked, so a `defineEndpoint(` written inside a comment, string or
 * template literal cannot register a phantom endpoint; the name and the fields
 * are read back from the ORIGINAL by offset. A call not bound to an exported
 * const is skipped (a test's local declaration).
 *
 * THROWS on an exported declaration whose `route:` is not one string literal:
 * every reader matches routes by their text, so a route it cannot read would
 * silently drop out of the docs and out of the coverage guard.
 */
export function endpointExports(
  path: string,
  src: string,
  /** `maskSource(src)`, when the caller already holds it. */
  masked?: string,
): EndpointExport[] {
  if (!src.includes("defineEndpoint")) return [];
  masked ??= maskSource(src);
  const out: EndpointExport[] = [];
  for (const span of markerCallSpans(masked, "defineEndpoint")) {
    const decl = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*$/.exec(
      masked.slice(0, span.identifier),
    );
    if (!decl) continue;
    const line = lineAt(src, span.identifier);
    const args = src.slice(span.open + 1, span.close);
    const open = maskSource(args).indexOf("{");
    const body = open < 0 ? "" : args.slice(open + 1);
    const route = parseStringField(body, "route", { depth0: true });
    if (route.kind !== "value") {
      throw new Error(
        `${path}:${line}: \`${decl[1]!}\` = defineEndpoint(…) has ` +
          (route.kind === "dynamic"
            ? `a \`route:\` that is not a string literal — got \`${route.expr}\`. `
            : "no `route:` in its spec object. ") +
          "Routes are read from source text (the docs, the browser-host coverage " +
          'guard); write it as one literal: `route: "POST /api/…"`.',
      );
    }
    const prediction = predictionOf(route.value, body);
    out.push({
      name: decl[1]!,
      route: route.value,
      needsMachine: hasField(body, "needsMachine", { depth0: true }),
      line,
      ...(prediction === undefined ? {} : { prediction }),
    });
  }
  return out;
}

/**
 * The decision arm of a spec-object `body`: `effect` → predicted, `internal`
 * → internal, `unpredicted: { reason }` / `{ gap }` → unpredicted / debt,
 * `agentWrite: "telemetry"` → telemetry. A read has none (`undefined`).
 */
function predictionOf(
  route: string,
  body: string,
): RoutePrediction | undefined {
  if (route.startsWith("GET ")) return undefined;
  const opts = { depth0: true };
  if (hasField(body, "effect", opts)) return "predicted";
  if (hasField(body, "internal", opts)) return "internal";
  if (hasField(body, "unpredicted", opts)) {
    const masked = maskSource(body);
    const at = /\bunpredicted\s*:\s*\{/.exec(masked);
    if (at) {
      const open = masked.indexOf("{", at.index);
      const close = matchBracket(masked, open, "{", "}");
      const inner = body.slice(open + 1, close < 0 ? undefined : close);
      const gap = parseStringField(inner, "gap", opts);
      if (gap.kind === "value") return { debt: gap.value };
      const reason = parseStringField(inner, "reason", opts);
      if (reason.kind === "value") return { unpredicted: reason.value };
    }
    return "undecided";
  }
  const agentWrite = parseStringField(body, "agentWrite", opts);
  if (agentWrite.kind === "value" && agentWrite.value === "telemetry")
    return "telemetry";
  return "undecided";
}
