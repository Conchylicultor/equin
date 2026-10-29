import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

// The tell of a hand-rolled marker-binding scanner: a `const … = <call>(`
// declaration scan. In a regex SOURCE the sequence is the literal word `const`,
// then (eventually) a binding `=`, then a NAMED CALL reaching a LITERAL open
// paren — `<ident>` (optionally dotted, e.g. `Pane\.define`) followed by
// optional `\s*`-style whitespace tokens and then `\(` (a backslash-escaped
// paren, i.e. the regex matches a real `foo(` / `foo.bar(` call opener in the
// scanned source, NOT a capture group `(`). This is exactly the shape of every
// `const X = pgTable("…")` / `const X = defineEndpoint(` / `const X =
// Pane.define({…})` scanner — the marker-value/binding footgun that must route
// through `markerCallSpans` instead.
const BINDING_CALL_SCAN =
  /\bconst\b[\s\S]*?=[\s\S]*?[A-Za-z_$][\w$]*(?:\\?\.\s*[A-Za-z_$][\w$]*)*(?:\\s[*+?]?)*\\\(/;

/**
 * Whether a regex source hand-rolls a `const <name> = <call>(` marker-binding
 * scan — the shape `markerCallSpans` / `findMarkerCalls` centralize. A
 * hand-rolled one run over RAW (un-masked) source also matches a binding written
 * inside a comment, string, or template literal — the string/comment-embedding
 * false positive this rule exists to make unrepresentable.
 *
 * Requires a literal `const … =` binding AND a named-call literal `\(` reach, so
 * a bare group-open `(` (a capture) or an object-literal `\{` binding
 * (`const X = { … }`) is NOT flagged. The `.table` alias form
 * (`const X = Y\.table`) has no `\(` and is likewise not flagged — it is a
 * construct detector, safe once run over masked source.
 */
export function isBindingScanSource(src: string): boolean {
  return BINDING_CALL_SCAN.test(src);
}

export default createRule({
  name: "no-adhoc-binding-scan",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled global `const <name> = <call>(` marker-binding " +
        "scanner regexes — route binding/marker-value scans through " +
        "`markerCallSpans` / `findMarkerCalls` (full-mask + read-by-offset).",
    },
    schema: [],
    messages: {
      adhocBindingScan:
        "This global regex hand-rolls a `const <name> = <call>(` scan. Run over " +
        "RAW (un-masked) source it also matches a call written INSIDE a comment, " +
        "string, or template literal (a test fixture, a docs snippet, a codegen " +
        "template) — a silent false positive that registers a phantom " +
        "table/route/pane/contribution. Locate genuine calls with " +
        "`markerCallSpans(maskSource(src), \"<marker>\")` (or " +
        "`findMarkerCalls(src, \"<marker>\")`) from " +
        "@plugins/plugin-meta/plugins/parse-utils/core, then read the binding " +
        "name and the string value back from the ORIGINAL by offset. The mask " +
        "preserves every offset 1:1, so a string-embedded call vanishes while a " +
        "real call's blanked id is recovered.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "Literal[regex]"(node) {
        // The footgun is WHOLE-FILE scanning — the `g` flag. A single-statement,
        // anchored parser (a preceding-`const … =$` decl matcher over one
        // already-located call, or a `route: "…"` field read) is not global and
        // is not the class.
        const regex = (node as { regex?: { pattern: string; flags: string } })
          .regex;
        if (!regex || !regex.flags.includes("g")) return;
        if (isBindingScanSource(regex.pattern)) {
          context.report({ node, messageId: "adhocBindingScan" });
        }
      },
    };
  },
});
