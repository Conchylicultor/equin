import type { CSSProperties } from "react";
import {
  CSS_IF_SUPPORTS,
  ROLE_PICK_CLASS,
  ROLE_PICK_COMPACT_CLASS,
  type PickRung,
  type RolePart,
} from "../../core";

/**
 * The role picker: a part's type comes from three TOKENS whose values name a
 * rung of the closed ladder, a shared weight and a family (`PICK_RUNGS` /
 * `PICK_EMPHASES` / `PICK_FAMILIES`, text core) — never a size.
 *
 * The part's scope (`rolePickScope`, on the text element itself or an
 * ancestor) copies its tokens into four GENERIC vars; the text element wears
 * its fallback rung plus ONE class — `role-pick`, or `role-pick-compact` in a
 * compact (`xs`) region — whose declarations dispatch on those vars with CSS
 * `if(style(…))`, so the rung's own metrics apply and the type-scale group
 * stays the one owner of every metric. That class is generated from the role
 * utilities (`rolePickCss`, text core) into ui-kit's `app.css`, in a cascade
 * layer above the utilities; see there for how it composes with the element's
 * other classes.
 *
 * It replaced ~25 per-rung `@container style()` classes per element: a
 * container query is evaluated per rule per element on every restyle, which
 * made a picked text ~1.5× as expensive to style as any other element.
 *
 * The fallback rung is folded into the scope's `--role-pick` (an unset token,
 * `initial`, takes it), so it also draws through the same declarations.
 *
 * An engine without `if()` (Safari, Firefox in 2026) drops those declarations
 * and reads the same picks from the stylesheet's `@supports not` block of
 * container style queries — today's per-element cost, only there. A style
 * query reads the PARENT's vars, so there the scope must sit on an ancestor:
 * `<Text pick>` reads `ROLE_PICK_SCOPE_ON_PARENT` to draw a box-less wrapper.
 */

/**
 * Whether this engine lacks CSS `if()`, so a pick's scope must sit on the
 * text element's parent for the style-query fallback to read it. Read once:
 * an engine does not change under a page.
 */
export const ROLE_PICK_SCOPE_ON_PARENT =
  typeof CSS === "undefined" || !CSS.supports(CSS_IF_SUPPORTS);

/** The generic vars a part's scope sets — read by the `role-pick` classes. */
const ROLE_PICK_VAR = "--role-pick";
const ROLE_EMPHASIS_VAR = "--role-emphasis";
const ROLE_FAMILY_VAR = "--role-family";
const ROLE_STEP_VAR = "--role-step";

/** The fallback rung itself: what an unset scope (no `--role-pick`) draws. */
const FALLBACK_CLASS: Record<PickRung, string> = {
  display: "text-display",
  title: "text-title",
  heading: "text-heading",
  subheading: "text-subheading",
  body: "text-body",
  label: "text-label",
  group: "text-group",
  caption: "text-caption",
  control: "text-control",
  tag: "text-tag font-tag",
  code: "text-code",
  "2xs": "text-2xs",
  "3xs": "text-3xs",
};

const FALLBACK_COMPACT_CLASS: Record<PickRung, string> = {
  display: "text-display-compact",
  title: "text-title-compact",
  heading: "text-heading-compact",
  subheading: "text-subheading-compact",
  body: "text-body-compact",
  label: "text-label-compact",
  group: "text-group-compact",
  control: "text-control-compact",
  caption: "text-caption-compact",
  tag: "text-tag-compact font-tag",
  code: "text-code-compact",
  "2xs": "text-2xs",
  "3xs": "text-3xs",
};

/**
 * The classes for the text element of a picked part: the fallback rung (base
 * or compact), then the picker class. For an element `<Text pick>` cannot be
 * (a header row's cells): put `rolePickScope(part)` on it or an ancestor, and
 * this on the element.
 */
export function rolePickClass(fallback: PickRung, compact = false): string {
  return compact
    ? `${FALLBACK_COMPACT_CLASS[fallback]} ${ROLE_PICK_COMPACT_CLASS}`
    : `${FALLBACK_CLASS[fallback]} ${ROLE_PICK_CLASS}`;
}

/**
 * The style that copies a part's tokens into the generic vars the picker
 * classes read — spread on the text element or an ancestor of it. Every var
 * is always valid: an unset token falls back to the part's fallback rung (and
 * `role` emphasis / family), so a pick never inherits an outer one.
 */
export function rolePickScope(part: RolePart): CSSProperties {
  return {
    [ROLE_PICK_VAR]: `var(${part.role}, ${part.fallback})`,
    [ROLE_EMPHASIS_VAR]: `var(${part.emphasis}, role)`,
    [ROLE_FAMILY_VAR]: `var(${part.family}, role)`,
    // Always set (`ambient` when the part has no step token), so the compact
    // class's two exclusive conditions cover every case.
    [ROLE_STEP_VAR]:
      part.step === undefined ? "ambient" : `var(${part.step}, ambient)`,
  } as CSSProperties;
}
