import {
  formatElementDescriptor,
  lineageNodeIdentity,
} from "@plugins/primitives/plugins/ui-context/core";
import {
  collectLineage,
  nearestOwner,
} from "@plugins/primitives/plugins/ui-context/web";
import type { InteractionTarget } from "../../core";

// What an interaction's event was aimed at, resolved at dispatch — while the
// node is still in the document (a slow switch usually remounts the very
// control, and Event Timing's `target` is null once it is gone). Reads
// attributes and text only, never computed style: this runs on the click path,
// and a style read there would itself force the style recalculation the
// detector exists to catch.

// The elements a person interacts with; the event target is often an icon or a
// span inside one.
const INTERACTIVE = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  ...[
    "button",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "checkbox",
    "radio",
    "option",
    "treeitem",
    "row",
    "gridcell",
    "slider",
    "combobox",
  ].map((r) => `[role="${r}"]`),
  // A focus-managed container (tabindex=-1: a pane, a list) is not a control.
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Buttons are named by their label ("Full screen", "Save"): an aria-label, the
// tooltip `title`, or their text. Every other element is named by its
// aria-label alone — a tab's, a menu item's, a link's or a row's text and
// title are the user's data (a page title, a task in a menu), which must never
// become part of an identity (nor split one control into one per record).
const LABEL_TEXT_ROLES = new Set(["button", "switch", "checkbox", "radio"]);

const NAME_MAX = 40;

function cap(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t;
}

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "button" || type === "submit" || type === "reset")
      return "button";
    if (type === "checkbox" || type === "radio") return type;
  }
  return undefined;
}

function nameOf(el: Element): string | undefined {
  const label = el.getAttribute("aria-label");
  if (label) return cap(label);
  const role = el.getAttribute("role") ?? implicitRole(el);
  if (!role || !LABEL_TEXT_ROLES.has(role)) return undefined;
  const text = cap(el.getAttribute("title") || el.textContent || "");
  return text || undefined;
}

/**
 * A key as its class: named keys as themselves (`Enter`, `ArrowDown`), a
 * chord as `Mod+K`, and a printable key alone as `char` — never what was typed.
 */
export function keyClass(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): string {
  if (e.key.length !== 1) return e.key;
  if (e.ctrlKey || e.metaKey)
    return `${e.altKey ? "Alt+" : ""}Mod+${e.key.toUpperCase()}`;
  return "char";
}

/** The identity of what `target` is part of, for an interaction of `kind`. */
export function interactionTarget(
  target: EventTarget | null,
  kind: InteractionTarget["kind"],
  key: string | null,
): InteractionTarget {
  const node =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  if (!node)
    return {
      kind,
      key,
      element: target === window || target === document ? "document" : "(none)",
      contribution: null,
      pane: null,
      owner: null,
    };
  const el = node.closest(INTERACTIVE) ?? node;
  const tag = el.tagName.toLowerCase();
  const explicitRole = el.getAttribute("role");
  const element = formatElementDescriptor({
    tag,
    role: explicitRole ?? undefined,
    type:
      tag === "input" ? (el as HTMLInputElement).type || undefined : undefined,
    name: nameOf(el),
  });
  const lineage = collectLineage(el);
  let contribution: string | null = null;
  let pane: string | null = null;
  for (const n of lineage) {
    if (n.kind === "contribution") contribution = lineageNodeIdentity(n);
    else if (n.regionKind === "pane") pane = lineageNodeIdentity(n);
  }
  const owner = nearestOwner(el);
  return {
    kind,
    key,
    element,
    contribution,
    pane,
    owner: owner ? (owner.split("@")[0] ?? owner) : null,
  };
}
