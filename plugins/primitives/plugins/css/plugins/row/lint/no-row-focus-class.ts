import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A focus or ring class authored on a `<Row>`/`<SectionHeaderRow>` styles a node
 * that stops being the focused one the day the row grows an action.
 *
 * `Row` renders as ONE element until it is given `actions`, at which point it
 * splits into a plain container box plus an inner `<button>`/`<a>` sibling of the
 * action cluster (nesting interactive elements is invalid DOM). `className` keeps
 * landing on the BOX. So a focus treatment authored here styles the box — which
 * stops being the focused node the day the row gains an action, while the browser
 * goes on drawing its own outline on the inner control. That is two nested
 * indicators for one focus, and it appeared without anyone editing the call site.
 *
 * `Row` therefore owns the focus treatment outright: it paints the app's canonical
 * ring (`focus-ring` + `focus-ring-from`) on the row box on BOTH paths and
 * suppresses the control's own outline. A focus or ring class on a `Row` is now
 * always either dead or a double-draw.
 *
 * The predicate reads the *token*, not the raw string: Tailwind's `!` important
 * marker is stripped and the variant chain is split bracket-aware, so
 * `dark:focus-visible:ring-2`, `hover:focus:outline-2` and
 * `has-[:focus-visible]:ring-3` are all seen for what they are. A token trips the
 * rule when its utility base is an `outline-*` / `ring-*` / `focus-ring-*`
 * treatment, OR when any variant in its chain is `focus`/`focus-visible`/
 * `focus-within`, OR when an arbitrary variant's selector text mentions `focus`.
 *
 * Like `no-adhoc-row` this walks the whole `className` attribute — tokens spread
 * across `cn()` fragments and conditional expressions aggregate into one Set — and
 * ships no auto-fix: deleting the styling versus reaching for `selected` is a
 * per-site judgement.
 *
 * `row/web/**` is path-exempt (`lint/index.ts`): the primitive is where the real
 * treatment is applied, and no class-level test can tell the definition site from
 * a copy of it. Same precedent as `no-adhoc-row`'s glob.
 */

// Utility bases that ARE a focus/ring treatment. `outline-none`, `outline-2`,
// `ring-1`, `ring-primary/30`, `ring-offset-2`, `focus-ring`, `focus-ring-from`.
const FOCUS_BASE = [/^outline(-|$)/, /^ring(-|$)/, /^focus-ring(-|$)/];
// Variants that ARE a focus modality, wherever they sit in the chain.
const FOCUS_VARIANTS = new Set(["focus", "focus-visible", "focus-within"]);

/**
 * Split a Tailwind token into its variant chain and its utility base, on `:`
 * separators at bracket/paren depth 0. A naive `split(":")` would shred an
 * arbitrary variant's selector (`has-[:focus-visible]:ring-2`,
 * `[&:focus]:outline-none`), which is exactly the shape this rule must see.
 */
function splitToken(token: string): { variants: string[]; base: string } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(token.slice(start));
  const base = parts.pop() ?? "";
  return { variants: parts, base };
}

/** Strip Tailwind's important marker in both spellings (`!ring-1`, `ring-1!`). */
function stripImportant(s: string): string {
  return s.replace(/^!+/, "").replace(/!+$/, "");
}

function isFocusToken(token: string): boolean {
  const { variants, base } = splitToken(token);
  for (const v of variants) {
    const variant = stripImportant(v);
    if (FOCUS_VARIANTS.has(variant)) return true;
    // Arbitrary/compound variant carrying a selector — `has-[:focus-visible]`,
    // `[&:focus]`, `group-has-[:focus-within]`. Its selector text is what makes
    // it a focus treatment, so read the text.
    if (variant.includes("[") && variant.includes("focus")) return true;
  }
  const utility = stripImportant(base);
  return FOCUS_BASE.some((re) => re.test(utility));
}

// The two components exported from `primitives/css/row`. Both split the same way.
const ROW_TAGS = new Set(["Row", "SectionHeaderRow"]);

export default function buildRule({ collectTokens }: LintToolkit) {
  return createRule({
    name: "no-row-focus-class",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow focus/ring classes (outline-*, ring-*, focus-ring-*, focus:/focus-visible:/focus-within: variants) on <Row>/<SectionHeaderRow> — Row owns its focus indicator, and such a class lands on the box that stops being the focused node once the row splits.",
      },
      schema: [],
      messages: {
        rowFocusClass:
          "Focus/ring class on a `Row` — `className` lands on the row BOX, but a `Row` with `actions` " +
          "splits and moves focus to an inner `<button>`/`<a>`, so this styling is either dead or drawn " +
          "on top of the control's own indicator. `Row` already paints the app's focus ring on both " +
          'paths. Delete the focus styling; if what you meant was "this is the current row", use ' +
          "`selected`. Last resort: // eslint-disable-next-line row/no-row-focus-class -- <reason>.",
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

          // Only `<Row>` / `<SectionHeaderRow>`. A JSXAttribute's parent is always
          // the JSXOpeningElement; the primitive's own internals render lowercase
          // host tags, so this never polices Row's implementation.
          const tag = node.parent.name;
          if (tag.type !== "JSXIdentifier" || !ROW_TAGS.has(tag.name)) return;

          // Aggregate every class token of this attribute into one Set.
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);

          for (const t of tokens) {
            if (isFocusToken(t)) {
              // No auto-fix — report once on the whole attribute.
              context.report({ node, messageId: "rowFocusClass" });
              return;
            }
          }
        },
      };
    },
  });
}
