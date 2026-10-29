import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-window-key-listener
 *
 * Bans `addEventListener("keydown" | "keyup" | "keypress", …)` on a page-wide
 * target — `window`, `document`, `globalThis`, `self`, `document.body`,
 * `document.documentElement` — outside the shortcut registry.
 *
 * A page-wide key listener hears every keystroke on the page. The app mounts
 * the same surface more than once at a time (every open tab stays mounted,
 * floating windows sit side by side), so a listener installed by one mounted
 * copy also fires for keystrokes meant for another. The ui-kit sidebar's ⌘B
 * did exactly that: one press toggled the sidebar of every mounted app.
 *
 * The registry (`primitives/shortcuts`) owns the one page-wide listener and
 * gates each shortcut on the focused surface, so registering through it makes
 * the right answer the default:
 *
 *   - `useSurfaceShortcuts` — a shortcut that belongs to the surface it is
 *     rendered in (fires only while that surface is focused);
 *   - `defineShortcut` — a genuinely page-wide shortcut.
 *
 * Element-scoped listeners (`el.addEventListener`, React `onKeyDown`) are not
 * flagged: they only hear keys aimed at their own element.
 *
 * Escape hatch — a need the registry can't express (keyup, a transient mode
 * that owns the keyboard while it is on screen) disables per site, and the
 * reason must say whose keystroke it is:
 *
 *   // eslint-disable-next-line shortcuts/no-window-key-listener -- <reason>
 */

const createRule = lintRuleCreator(import.meta.url);

const KEY_EVENTS = new Set(["keydown", "keyup", "keypress"]);
const GLOBAL_TARGETS = new Set(["window", "document", "globalThis", "self"]);
const DOCUMENT_ELEMENTS = new Set(["body", "documentElement"]);

function propertyName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return null;
}

/** `document`, or `document` reached through a global (`window.document`). */
function isDocument(node: TSESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "document";
  return (
    node.type === "MemberExpression" &&
    propertyName(node) === "document" &&
    isPageWideTarget(node.object)
  );
}

/** `window`, `document`, `window.document`, `document.body`, … */
function isPageWideTarget(node: TSESTree.Node): boolean {
  if (node.type === "Identifier") return GLOBAL_TARGETS.has(node.name);
  if (node.type !== "MemberExpression") return false;
  const name = propertyName(node);
  if (name === null) return false;
  // `window.document` / `globalThis.window` — a global reached through another.
  if (GLOBAL_TARGETS.has(name)) return isPageWideTarget(node.object);
  // `document.body` / `document.documentElement` — every key bubbles through.
  return DOCUMENT_ELEMENTS.has(name) && isDocument(node.object);
}

/** The literal event name of `addEventListener`'s first argument, or null. */
function eventName(
  node: TSESTree.CallExpressionArgument | undefined,
): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

export default createRule({
  name: "no-window-key-listener",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow page-wide key listeners outside the shortcut registry — they " +
        "fire for every mounted copy of a surface, not only the focused one.",
    },
    schema: [],
    messages: {
      windowKeyListener:
        "A `{{event}}` listener on a page-wide target hears every keystroke on " +
        "the page, including ones meant for another mounted copy of this surface " +
        "(open tabs stay mounted; floating windows sit side by side). Register " +
        "through @plugins/primitives/plugins/shortcuts/web instead: " +
        "useSurfaceShortcuts for a shortcut that belongs to this surface (fires " +
        "only while it is focused), defineShortcut for a genuinely page-wide one. " +
        "If the registry can't express it (keyup, a transient mode that owns the " +
        "keyboard while on screen), gate on the focused surface yourself and " +
        "disable this rule on the line with a reason saying whose keystroke it is.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (propertyName(callee) !== "addEventListener") return;
        const event = eventName(node.arguments[0]);
        if (event === null || !KEY_EVENTS.has(event)) return;
        if (!isPageWideTarget(callee.object)) return;
        context.report({
          node,
          messageId: "windowKeyListener",
          data: { event },
        });
      },
    };
  },
});
