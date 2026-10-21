// Types for the custom-utility twMerge registry. This file is hand-authored and
// DATA-FREE: it holds only the shape contracts. The *data* (every custom
// `@utility` class paired with its twMerge classification) is GENERATED from the
// `/* twmerge: … */` markers in app.css into `./custom-utilities.generated.ts`.
// Both that generated file and `../lib/utils.ts` import these types.
//
// Why this exists: tailwind-merge classifies a class by its name. A custom utility
// whose suffix is a word (`text-caption`, `z-base`, …) gets misfiled into a
// built-in group — usually text-color for `text-*` — and silently stripped when a
// real class from that group appears later in the string. Registering the literal
// names into the correct group fixes the whole class of bug.
//
// — twMerge wiring ————————————————————————————————————————————————————————————
// `extend`     append the literals into an existing built-in tailwind-merge group.
//              Gives order-independent mutual conflict for free AND moves the class
//              out of any wrong fallback group (e.g. text-* out of text-color).
//              Use for single-property utilities whose property maps 1:1 to one
//              built-in group. Marker in app.css: `/* twmerge: extend <builtin> */`.
// `group`+`excludes`  synthetic group MUTUALLY exclusive with the listed built-in
//              groups: whichever class comes last survives and the other is
//              removed, in either order. Use for multi-property utilities (w+h) or
//              when a single property is covered by several built-in groups
//              (height → both `h` and `size`). Marker: `/* twmerge: <sg-id> */`,
//              with one `/* @twmerge group <sg-id> excludes: … */` decl per group.
//              `../lib/utils.ts` CLOSES the list over tailwind-merge's own map, so
//              listing `p` also beats `px`/`pt`/`ps`/… and listing `h` also submits
//              to `size` — list only what must be mutually exclusive.
// `under`      the one-directional escape, per built-in and with a required reason:
//              the built-in is strictly BROADER, so a later built-in removes the
//              group but a later group member must NOT remove the built-in (the
//              part of it the group does not own legitimately survives). Spelled
//              `under: <builtin…> -- <reason>` in the group decl. Nothing needs one
//              today — the closure supplies every case the eight groups have — so
//              reach for it only when you can write the reason.
// `standalone` intentionally outside twMerge; `reason` is required and documents
//              why. Marker: `/* twmerge: standalone -- <reason> */`.

// The fixed allow-list of built-in tailwind-merge group ids the project extends.
// The generator owns its own copy of these literals (it can't import this file —
// cross-plugin boundary) and validates every `extend <id>` / `excludes: <id>` /
// `under: <id>` marker against it; keep the two in sync. `../lib/utils.ts` asserts
// at load that every declared id is a real tailwind-merge class group, which is the
// backstop for that duplication.
export type BuiltinGroupId =
  | "font-size"
  | "font-weight"
  | "z"
  | "h"
  | "w"
  | "size"
  | "min-h"
  | "p"
  | "px"
  | "py"
  | "pt"
  | "pr"
  | "pb"
  | "pl"
  | "gap"
  | "gap-x"
  | "gap-y"
  | "rounded"
  | "shadow"
  | "animate"
  | "border-w-b"
  | "backdrop-filter"
  | "backdrop-blur"
  | "backdrop-brightness"
  | "backdrop-contrast"
  | "backdrop-grayscale"
  | "backdrop-hue-rotate"
  | "backdrop-invert"
  | "backdrop-opacity"
  | "backdrop-saturate"
  | "backdrop-sepia";

/** A `under:` relation: one built-in group, and why it is one-directional. */
export interface UnderRelation {
  group: BuiltinGroupId;
  reason: string;
}

export type RegistryEntry =
  | { classes: readonly string[]; extend: BuiltinGroupId }
  | {
      classes: readonly string[];
      group: string;
      excludes: readonly BuiltinGroupId[];
      /** Always present, usually empty — see `under` in the wiring notes above. */
      under: readonly UnderRelation[];
    }
  | { classes: readonly string[]; standalone: true; reason: string };
