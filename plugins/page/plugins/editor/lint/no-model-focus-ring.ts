import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type {
  LintToolkit,
  TokenNode,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A focus indicator painted from a model boolean is an indicator that can
 * disagree with the browser.
 *
 * Focus already has a CSS state — `:focus-visible`, and the app's canonical
 * `focus-ring` / `focus-ring-within` / `focus-ring-from` utilities in `ui-kit`'s
 * `app.css`, which are that state given the app's look. A boolean named
 * `isFocused` is not that state: in the page editor it is
 * `focusedBlockId === block.id`, which is where the EDITOR thinks the caret is.
 * The two are separate facts, and they come apart — a block can hold real DOM
 * focus while the editor's state has moved on, or the other way round.
 *
 * Painting the indicator off the model is what makes the disagreement visible as
 * a bug. The page editor's divider suppressed the browser's own outline
 * unconditionally (`outline-none`) and redrew a ring only while `isFocused`, so a
 * box that HAD DOM focus while the editor disagreed showed no indicator at all:
 * the user's keyboard focus was somewhere nothing was drawn. Two conditions, one
 * indicator — and the one the browser knows about had been switched off.
 *
 * So the rule anchors on the GATE, not on an element name: a focus/ring/outline
 * token sitting in a branch that only renders because `isFocused` is (or is not)
 * true. Everything else about the token is read the way
 * `row/no-row-focus-class` reads it — `!` stripped in both spellings, the variant
 * chain split bracket-aware so `has-[:focus-visible]:ring-2` and
 * `[&:focus]:outline-none` are seen for what they are, and a token trips on an
 * `outline-*` / `ring-*` / `focus-ring-*` base OR a `focus`/`focus-visible`/
 * `focus-within` variant anywhere in its chain.
 *
 * The two fixes, per what the author actually meant:
 *   - "this element has keyboard focus" → the `focus-ring` utility family, which
 *     fires from `:focus-visible` and therefore cannot drift from the browser.
 *   - "the editor's caret is on this block" → nothing at all, for a text-less
 *     block: it registers `caret: "editor"` and `BlockRow` mounts the cue for
 *     it. A block that must hold the caret itself (`caret: "renderer"`) uses
 *     `Row`'s `selected`, which paints the same tint. That is a different
 *     question from focus and it reads as a different cue, so the two may
 *     legally layer.
 *
 * No auto-fix: deleting the styling versus declaring `caret: "editor"` is a
 * per-site judgement.
 */

// Utility bases that ARE a focus/ring treatment. `outline-none`, `outline-2`,
// `ring-1`, `ring-primary/30`, `ring-offset-2`, `focus-ring`, `focus-ring-from`.
const FOCUS_BASE = [/^outline(-|$)/, /^ring(-|$)/, /^focus-ring(-|$)/];
// Variants that ARE a focus modality, wherever they sit in the chain.
const FOCUS_VARIANTS = new Set(["focus", "focus-visible", "focus-within"]);
// The model fact this rule is about. A prop, a destructured local, a member read
// — all of them spell the same name.
const MODEL_FOCUS_NAME = "isFocused";

/**
 * Split a Tailwind token into its variant chain and its utility base, on `:`
 * separators at bracket/paren depth 0. A naive `split(":")` would shred an
 * arbitrary variant's selector (`has-[:focus-visible]:ring-2`,
 * `[&:focus]:outline-none`), which is exactly the shape this rule must see.
 *
 * Copied rather than imported: lint rule files are dual-loaded through jiti,
 * which cannot resolve `@plugins/*`, so a rule must be self-contained. Same
 * constraint, same duplication, as `row`'s two rules.
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

/**
 * Does this expression consult the model's focus fact? An `Identifier` named
 * `isFocused` (`isFocused && …`, `!isFocused && …`), or a `MemberExpression`
 * reading that property (`props.isFocused`, `region.isFocused`,
 * `props["isFocused"]`), anywhere inside. Negation counts: an indicator drawn
 * while the model says NOT focused is just as model-driven.
 */
function referencesModelFocus(node: TSESTree.Node | null | undefined): boolean {
  if (!node) return false;
  if (node.type === "Identifier" && node.name === MODEL_FOCUS_NAME) return true;
  if (
    node.type === "MemberExpression" &&
    node.computed &&
    node.property.type === "Literal" &&
    node.property.value === MODEL_FOCUS_NAME
  )
    return true;
  return someChild(node, referencesModelFocus);
}

/** Visit every child node / array-of-nodes, short-circuiting on the first hit. */
function someChild(
  node: TSESTree.Node,
  fn: (child: TSESTree.Node) => boolean,
): boolean {
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          if (fn(child as TSESTree.Node)) return true;
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      if (fn(value as TSESTree.Node)) return true;
    }
  }
  return false;
}

export default function buildRule({ collectTokenNodes }: LintToolkit) {
  return createRule({
    name: "no-model-focus-ring",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow a focus/ring/outline class (outline-*, ring-*, focus-ring-*, focus:/focus-visible:/focus-within: variants) inside a class expression gated on `isFocused` — `isFocused` is a model fact, and an indicator painted from it desynchronizes from real DOM focus.",
      },
      schema: [],
      messages: {
        modelFocusRing:
          "`{{token}}` is a focus indicator painted from `isFocused`, a MODEL fact (the editor's idea of " +
          "where the caret is), not the browser's `:focus-visible`. The two come apart, and then the " +
          'element the user is actually focused on shows nothing. If you mean "this element has keyboard ' +
          'focus", use the `focus-ring` utility family (unconditionally — it fires from `:focus-visible`). ' +
          'If you mean "the editor\'s caret is on this block", register the block type with ' +
          '`caret: "editor"` and delete this — `BlockRow` paints the cue for you; a block that must ' +
          "hold the caret itself uses `Row`'s `selected`, which paints the same tint. " +
          "Last resort: // eslint-disable-next-line page-editor/no-model-focus-ring -- <reason>.",
      },
    },
    defaultOptions: [],
    create(context) {
      // A branch can be visited twice (an `isFocused ? … : …` nested inside an
      // `isFocused && …`), so remember what has already been reported.
      const reported = new Set<string>();

      function reportBranch(branch: TSESTree.Node | null | undefined): void {
        const found: TokenNode[] = [];
        collectTokenNodes(context.sourceCode, branch, found);
        for (const { token, node } of found) {
          if (!isFocusToken(token)) continue;
          const key = `${node.range[0]}:${node.range[1]}:${token}`;
          if (reported.has(key)) continue;
          reported.add(key);
          context.report({
            node,
            messageId: "modelFocusRing",
            data: { token },
          });
        }
      }

      return {
        // `isFocused && "ring-1"` — the right side renders only under the gate.
        LogicalExpression(node) {
          if (node.operator !== "&&") return;
          if (!referencesModelFocus(node.left)) return;
          reportBranch(node.right);
        },
        // `isFocused ? "ring-2" : "ring-0"` — BOTH arms are the gate's doing.
        ConditionalExpression(node) {
          if (!referencesModelFocus(node.test)) return;
          reportBranch(node.consequent);
          reportBranch(node.alternate);
        },
      };
    },
  });
}
