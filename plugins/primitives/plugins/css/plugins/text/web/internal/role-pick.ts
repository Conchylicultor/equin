import type { CSSProperties } from "react";
import type { PickEmphasis, PickFamily, PickRung, RolePart } from "../../core";

/**
 * The role picker: a part's type comes from three TOKENS whose values name a
 * rung of the closed ladder, a shared weight and a family (`PICK_RUNGS` /
 * `PICK_EMPHASES` / `PICK_FAMILIES`, text core) — never a size.
 *
 * A part's wrapper copies its three tokens into three GENERIC vars
 * (`rolePickScope`); the text element under it carries the fallback rung plus
 * one CSS style-query class per value of each axis (`rolePickClass`), so the
 * rung's own `text-<role>` utility — size, leading, weight, `--font-scale` —
 * applies, and the type-scale group stays the one owner of every metric. The
 * wrapper may be `display: contents` (`<Text pick>` draws one): a style query
 * is answered by the parent's computed vars, which a contents box still has.
 *
 * Every table is written LITERALLY (Tailwind only generates what it sees) and
 * typed `Record<…, string>` over its vocabulary, so it covers it; the
 * type-scale check (rule 6, `ROLE_PICKERS`) holds the rung tables to the
 * ladder.
 *
 * Emphasis and family are `!important`: Tailwind orders arbitrary variants by
 * their text, so `style(--role-emphasis:…)` would sort BEFORE
 * `style(--role-pick:…)` and lose to the rung's own weight. A picked weight /
 * family is the token's word, so beating a caller's class is intended.
 *
 * An unset token (`initial`) makes its generic var invalid (not inherited from
 * an outer pick): no query matches and the fallback rung draws.
 */

/** The generic vars a part's wrapper sets — read by every pick table. */
const ROLE_PICK_VAR = "--role-pick";
const ROLE_EMPHASIS_VAR = "--role-emphasis";
const ROLE_FAMILY_VAR = "--role-family";
const ROLE_STEP_VAR = "--role-step";

/** Each rung's own utility, under its style query. */
const RUNG_CLASS: Record<PickRung, string> = {
  display: "[@container_style(--role-pick:display)]:text-display",
  title: "[@container_style(--role-pick:title)]:text-title",
  heading: "[@container_style(--role-pick:heading)]:text-heading",
  subheading: "[@container_style(--role-pick:subheading)]:text-subheading",
  body: "[@container_style(--role-pick:body)]:text-body",
  label: "[@container_style(--role-pick:label)]:text-label",
  group: "[@container_style(--role-pick:group)]:text-group",
  caption: "[@container_style(--role-pick:caption)]:text-caption",
  control: "[@container_style(--role-pick:control)]:text-control",
  tag: "[@container_style(--role-pick:tag)]:text-tag [@container_style(--role-pick:tag)]:font-tag",
  code: "[@container_style(--role-pick:code)]:text-code",
  "2xs": "[@container_style(--role-pick:2xs)]:text-2xs",
  "3xs": "[@container_style(--role-pick:3xs)]:text-3xs",
};

/**
 * The compact rung of each (`textStepFor` === 1, an `xs` region such as a
 * `DataTable`): the weight-preserving `-compact` utility, as `<Text variant>`
 * swaps in — while the part's step (`--role-step`, the `…Step` token) is
 * `ambient`; under `base` the rung itself, so a theme's literal pick draws
 * the rung it names. The two queries are exclusive, so neither has to win.
 * The sub-scale is already below role granularity and stays put.
 */
const RUNG_COMPACT_CLASS: Record<PickRung, string> = {
  display:
    "[@container_style(--role-pick:display)_and_style(--role-step:ambient)]:text-display-compact [@container_style(--role-pick:display)_and_style(--role-step:base)]:text-display",
  title:
    "[@container_style(--role-pick:title)_and_style(--role-step:ambient)]:text-title-compact [@container_style(--role-pick:title)_and_style(--role-step:base)]:text-title",
  heading:
    "[@container_style(--role-pick:heading)_and_style(--role-step:ambient)]:text-heading-compact [@container_style(--role-pick:heading)_and_style(--role-step:base)]:text-heading",
  subheading:
    "[@container_style(--role-pick:subheading)_and_style(--role-step:ambient)]:text-subheading-compact [@container_style(--role-pick:subheading)_and_style(--role-step:base)]:text-subheading",
  body: "[@container_style(--role-pick:body)_and_style(--role-step:ambient)]:text-body-compact [@container_style(--role-pick:body)_and_style(--role-step:base)]:text-body",
  label:
    "[@container_style(--role-pick:label)_and_style(--role-step:ambient)]:text-label-compact [@container_style(--role-pick:label)_and_style(--role-step:base)]:text-label",
  group:
    "[@container_style(--role-pick:group)_and_style(--role-step:ambient)]:text-group-compact [@container_style(--role-pick:group)_and_style(--role-step:base)]:text-group",
  caption:
    "[@container_style(--role-pick:caption)_and_style(--role-step:ambient)]:text-caption-compact [@container_style(--role-pick:caption)_and_style(--role-step:base)]:text-caption",
  control:
    "[@container_style(--role-pick:control)_and_style(--role-step:ambient)]:text-control-compact [@container_style(--role-pick:control)_and_style(--role-step:base)]:text-control",
  tag: "[@container_style(--role-pick:tag)_and_style(--role-step:ambient)]:text-tag-compact [@container_style(--role-pick:tag)_and_style(--role-step:base)]:text-tag [@container_style(--role-pick:tag)]:font-tag",
  code: "[@container_style(--role-pick:code)_and_style(--role-step:ambient)]:text-code-compact [@container_style(--role-pick:code)_and_style(--role-step:base)]:text-code",
  "2xs": "[@container_style(--role-pick:2xs)]:text-2xs",
  "3xs": "[@container_style(--role-pick:3xs)]:text-3xs",
};

/** The fallback rung itself, unconditional (an unset role token). */
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

/** The weight axis: `role` keeps the rung's; `parent` takes the container's. */
const EMPHASIS_CLASS: Record<PickEmphasis, string> = {
  role: "",
  normal: "[@container_style(--role-emphasis:normal)]:font-normal!",
  medium: "[@container_style(--role-emphasis:medium)]:font-medium!",
  semibold: "[@container_style(--role-emphasis:semibold)]:font-semibold!",
  bold: "[@container_style(--role-emphasis:bold)]:font-bold!",
  parent: "[@container_style(--role-emphasis:parent)]:[font-weight:inherit]!",
};

/** The family axis: `role` keeps the rung's (mono for `code`). */
const FAMILY_CLASS: Record<PickFamily, string> = {
  role: "",
  sans: "[@container_style(--role-family:sans)]:font-sans!",
  mono: "[@container_style(--role-family:mono)]:font-mono!",
};

const PICK_TABLES = [
  ...Object.values(EMPHASIS_CLASS),
  ...Object.values(FAMILY_CLASS),
]
  .filter(Boolean)
  .join(" ");
const PICK_CLASS = Object.values(RUNG_CLASS).join(" ");
const PICK_COMPACT_CLASS = Object.values(RUNG_COMPACT_CLASS).join(" ");

/**
 * The classes for the text element of a picked part: the fallback rung, then
 * every rung / emphasis / family query (the base or `compact` rungs). For an
 * element `<Text pick>` cannot be (a header row's cells): put
 * `rolePickScope(part)` on an ancestor (the parent, or a `display: contents`
 * wrapper) and this on the element.
 */
export function rolePickClass(fallback: PickRung, compact = false): string {
  return [
    (compact ? FALLBACK_COMPACT_CLASS : FALLBACK_CLASS)[fallback],
    compact ? PICK_COMPACT_CLASS : PICK_CLASS,
    PICK_TABLES,
  ].join(" ");
}

/**
 * The style that copies a part's three tokens into the generic vars every pick
 * table reads — spread on the part's wrapper (the parent of the element
 * carrying `rolePickClass`).
 */
export function rolePickScope(part: RolePart): CSSProperties {
  return {
    [ROLE_PICK_VAR]: `var(${part.role})`,
    [ROLE_EMPHASIS_VAR]: `var(${part.emphasis})`,
    [ROLE_FAMILY_VAR]: `var(${part.family})`,
    // Always set (`ambient` when the part has no step token), so the compact
    // table's two exclusive queries cover every case.
    [ROLE_STEP_VAR]:
      part.step === undefined ? "ambient" : `var(${part.step}, ambient)`,
  } as CSSProperties;
}
