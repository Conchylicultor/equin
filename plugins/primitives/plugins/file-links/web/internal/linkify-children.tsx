import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { FileLinkText } from "./file-link-text";

const SKIP_TYPES = new Set(["code", "pre", "a"]);

// Recursively walks a ReactNode tree and replaces plain string nodes with
// linkified versions. Skips `code`, `pre`, and `a` so file paths inside code
// blocks or existing links aren't double-handled. Custom components (non-HTML
// element types) are also left opaque — they manage their own children and
// rewriting them can corrupt the props the component depends on (e.g. the
// active-data ConvChip relies on its children being the raw conv-id string).
//
// Public entry: guards the silent-no-op footgun (a custom-component *root* is
// left opaque, so nothing inside is linkified — the sanctioned path is
// <InlineText> with a string seed; see plugins/primitives/plugins/inline-text),
// then walks. Never throws, so the rendered output is unchanged.
export function linkifyChildren(
  children: ReactNode,
  fileTarget?: (path: string, line?: number) => Activation,
): ReactNode {
  if (process.env.NODE_ENV !== "production") {
    if (
      isValidElement(children) &&
      children.type !== Fragment &&
      typeof children.type !== "string"
    ) {
      console.error(
        "[file-links] linkifyChildren was seeded with a custom-component root; walkers leave custom components opaque, so nothing inside is linkified. Seed with a raw string via <InlineText> instead of hand-composing walkers.",
      );
    }
  }
  return walkLinkify(children, fileTarget);
}

function walkLinkify(
  children: ReactNode,
  fileTarget?: (path: string, line?: number) => Activation,
): ReactNode {
  if (children == null || typeof children === "boolean") return children;
  if (typeof children === "string") {
    return <FileLinkText text={children} fileTarget={fileTarget} />;
  }
  if (typeof children === "number") return children;
  if (Array.isArray(children)) {
    return Children.map(children, (child, i) => (
      <Fragment key={i}>{walkLinkify(child, fileTarget)}</Fragment>
    ));
  }
  if (isValidElement(children)) {
    const el = children as ReactElement<{ children?: ReactNode }>;
    // Fragments are transparent — recurse so upstream walkers (e.g. the
    // active-data linkify) can wrap text in fragments and we still see the
    // strings inside.
    if (el.type === Fragment) {
      return <Fragment>{walkLinkify(el.props.children, fileTarget)}</Fragment>;
    }
    if (typeof el.type !== "string") return el;
    if (SKIP_TYPES.has(el.type)) return el;
    const inner = el.props.children;
    if (inner === undefined) return el;
    return cloneElement(el, undefined, walkLinkify(inner, fileTarget));
  }
  return children;
}
