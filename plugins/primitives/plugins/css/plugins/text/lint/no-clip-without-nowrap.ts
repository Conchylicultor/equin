import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The "overflow-hidden trap" guardrail.
 *
 * A horizontal flex row that carries `overflow-hidden` but NOT `whitespace-nowrap`
 * (nor `truncate`, which implies nowrap) is single-line chrome that LOOKS defended
 * but isn't: `overflow-hidden` clips text that has ALREADY wrapped to a second line —
 * it does not stop the wrap. So a toolbar / header / chip row silently grows a second
 * line and the clip hides the overflow, not the wrap. This is exactly the bug the
 * region primitives (app-shell toolbar, PaneChrome) each had.
 *
 * The fix is `whitespace-nowrap` on the row so children never wrap in the first place
 * (truncation then stays the job of the flexible leaf — a `<Text>` inside a line
 * container, which ellipsizes via the ambient single-line context), and
 * `overflow-hidden` clips the single line if it still doesn't fit.
 *
 * Fingerprint (a *co-occurrence* that may live across several `cn()` fragments, so we
 * aggregate every class token of one `className` into one Set first):
 *   - a flex DISPLAY (`flex` / `inline-flex`)
 *   - a clip (`overflow-hidden` / `overflow-clip`, x-axis variants included)
 *   - NO `whitespace-nowrap` and NO `truncate`
 * Excluded (the wrap is intended, or it's a 2D region — not a single-line text row):
 *   - `flex-col` / `flex-col-reverse` (vertical — wrapping isn't the failure mode)
 *   - `flex-wrap` / `flex-wrap-reverse` (author explicitly opted into multi-line)
 *   - a vertical-sizing signal (`h-full` / `h-screen` / `min-h-0`) — a row that fills
 *     its own height is a 2D layout region clipping panels, not a text bar
 *   - cross-axis start/end/stretch alignment (`items-start` / `items-end` /
 *     `items-stretch`) — a single-line text row centers its children (`items-center`);
 *     non-center alignment means multi-height children, i.e. a 2D block
 * Forcing `whitespace-nowrap` on those would wrongly freeze descendant text wrapping.
 *
 * Fires only on intrinsic host tags (lowercase) — a `<Stack>` / `<Card>` component owns
 * its own internals. No auto-fix: whether the right answer is nowrap on the row, a
 * `truncate` leaf, or an intended `flex-col`/`flex-wrap` is a per-site judgement.
 */

// Flex display tokens — the row that can wrap.
const FLEX_DISPLAY = new Set(["flex", "inline-flex"]);
// Clip tokens — `overflow-hidden`/`overflow-clip` and their x-axis variants.
const CLIP = new Set([
  "overflow-hidden",
  "overflow-clip",
  "overflow-x-hidden",
  "overflow-x-clip",
]);
// Single-line guarantees that make the row safe. `region-line` is the shared
// single-line region utility (Bar / Row / chips) — it bakes in `whitespace-nowrap`,
// so a row carrying it is just as defended as one with the raw class.
const NOWRAP = new Set(["whitespace-nowrap", "truncate", "region-line"]);
// Wrap-intended / 2D-region escapes — vertical stack, explicit multi-line wrap,
// a self-sizing-height layout region, or cross-axis non-center alignment (all of
// which mean "not a single-line text row", so nowrap would be wrong).
const WRAP_OK = new Set([
  "flex-col",
  "flex-col-reverse",
  "flex-wrap",
  "flex-wrap-reverse",
  "h-full",
  "h-screen",
  "min-h-0",
  "items-start",
  "items-end",
  "items-stretch",
]);

export default function buildRule({ collectTokens, ownClass }: LintToolkit) {
  return createRule({
    name: "no-clip-without-nowrap",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow a horizontal flex row with overflow-hidden but no whitespace-nowrap/truncate — overflow-hidden clips already-wrapped text, it does not prevent the wrap. Add whitespace-nowrap (single-line chrome) or flex-col/flex-wrap (intended multi-line).",
      },
      schema: [],
      messages: {
        clipWithoutNowrap:
          "Single-line trap: this flex row has `overflow-hidden` but no `whitespace-nowrap` " +
          "(nor `truncate`). `overflow-hidden` clips text that has ALREADY wrapped — it does not " +
          "stop the wrap, so the row silently grows a second line. Add `whitespace-nowrap` so " +
          "children never wrap (let a `truncate` / `<Text>`-in-a-line-container leaf ellipsize). If " +
          "multi-line is intended, use `flex-col`/`flex-wrap`, or " +
          "`// eslint-disable-next-line text/no-clip-without-nowrap -- <reason>`.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(node) {
          // Only `className` attributes.
          if (
            node.name.type !== "JSXIdentifier" ||
            node.name.name !== "className"
          )
            return;

          // Host-tag gate: fire only on intrinsic elements (lowercase tag). A
          // capitalized component (`<Stack>`, `<Card>`) owns its own internals.
          const tag = node.parent.name;
          if (tag.type !== "JSXIdentifier") return;
          const first = tag.name[0];
          if (!first || first !== first.toLowerCase()) return;

          // Aggregate every (variant-stripped) class token into one Set.
          const tokens = new Set<string>();
          const raw = new Set<string>();
          collectTokens(context.sourceCode, node.value, raw);
          for (const t of raw) {
            const c = ownClass(t);
            if (c !== undefined) tokens.add(c);
          }

          let hasFlex = false;
          let hasClip = false;
          let safe = false;
          for (const t of tokens) {
            if (FLEX_DISPLAY.has(t)) hasFlex = true;
            if (CLIP.has(t)) hasClip = true;
            if (NOWRAP.has(t) || WRAP_OK.has(t)) safe = true;
          }

          if (hasFlex && hasClip && !safe) {
            context.report({ node, messageId: "clipWithoutNowrap" });
          }
        },
      };
    },
  });
}
