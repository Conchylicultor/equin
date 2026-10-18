import { it, expect } from "bun:test";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import { CUSTOM_UTILITY_REGISTRY } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/custom-utilities.generated";

// `cn()` returns the branded `ClassName`, so `expect(cn(…)).toBe("size-5")` would
// demand a branded literal on the right. These tests are about what twMerge does
// to the STRING, not about the brand — so each assertion is widened at the
// `expect` call (`expect<string>`) to the type it is actually about.

// A real class from each built-in tailwind-merge group a synthetic group may name,
// so the table below can exercise a relation without hardcoding which groups exist.
// Raw utilities are the SUBJECT of these assertions — the point is how cn() treats
// them next to a custom one.
const REPRESENTATIVE: Record<string, string> = {
  p: "p-2",
  px: "px-2",
  py: "py-2",
  pt: "pt-2",
  pr: "pr-2",
  pb: "pb-2",
  pl: "pl-2",
  h: "h-8",
  w: "w-8",
  size: "size-8",
  "min-h": "min-h-8",
  gap: "gap-2",
  "gap-x": "gap-x-2",
  "gap-y": "gap-y-2",
  rounded: "rounded-md",
  z: "z-10",
  "font-size": "text-sm",
  "backdrop-filter": "backdrop-filter-none",
  "backdrop-blur": "backdrop-blur-md",
  "backdrop-brightness": "backdrop-brightness-50",
  "backdrop-contrast": "backdrop-contrast-50",
  "backdrop-grayscale": "backdrop-grayscale",
  "backdrop-hue-rotate": "backdrop-hue-rotate-90",
  "backdrop-invert": "backdrop-invert",
  "backdrop-opacity": "backdrop-opacity-50",
  "backdrop-saturate": "backdrop-saturate-150",
  "backdrop-sepia": "backdrop-sepia",
};

function representativeFor(builtin: string, group: string): string {
  const sample = REPRESENTATIVE[builtin];
  if (!sample) {
    // Loud rather than skipped: a group naming a group with no sample would
    // otherwise silently contribute zero assertions to the table.
    throw new Error(
      `no representative class for tailwind-merge group "${builtin}" (named by ${group}). ` +
        `Add one to REPRESENTATIVE in this file.`,
    );
  }
  return sample;
}

const GROUP_ENTRIES = CUSTOM_UTILITY_REGISTRY.filter(
  (entry): entry is Extract<typeof entry, { group: string }> =>
    "group" in entry,
);

// — Tier 1: every declared relation, driven from the generated registry ————————
//
// This is the invariant the `excludes:` spelling exists for: a synthetic group and
// a built-in it names can never both survive, WHICHEVER order they compose in. The
// table is derived, so a new synthetic group cannot ship untested.

it("declares at least one synthetic group to exercise", () => {
  expect(GROUP_ENTRIES.length).toBeGreaterThan(0);
});

for (const entry of GROUP_ENTRIES) {
  const member = entry.classes[0]!;

  for (const builtin of entry.excludes) {
    const sample = representativeFor(builtin, entry.group);

    it(`${entry.group}: a later ${builtin} removes ${member}`, () => {
      expect<string>(cn(member, sample)).toBe(sample);
    });

    it(`${entry.group}: a later ${member} removes ${builtin}`, () => {
      expect<string>(cn(sample, member)).toBe(member);
    });
  }

  // The one-directional escape, asserted in both directions so the asymmetry it
  // buys is the thing under test rather than an accident. Empty today.
  for (const { group: builtin } of entry.under) {
    const sample = representativeFor(builtin, entry.group);

    it(`${entry.group}: a later ${builtin} removes ${member} (under)`, () => {
      expect<string>(cn(member, sample)).toBe(sample);
    });

    it(`${entry.group}: a later ${member} does NOT remove ${builtin} (under)`, () => {
      const result = cn(sample, member);
      expect<string>(result).toContain(sample);
      expect<string>(result).toContain(member);
    });
  }
}

// — Tier 2: relations the closure derives, which no declared list names ————————

it("a rail publishes on the inline axis only, so p keeps its block padding", () => {
  // `p` is broader than `sg-rail-x`: a later p replaces the region outright, but a
  // later rail-x must not delete p (its block half is legitimately still applied).
  expect<string>(cn("rail-x-lg", "p-2")).toBe("p-2");
  const both = cn("p-2", "rail-x-lg");
  expect<string>(both).toContain("p-2");
  expect<string>(both).toContain("rail-x-lg");
});

it("size is broader than a height-only control utility", () => {
  // A later size-8 drops control-sm; a later control-sm must not drop size-8 and
  // take its width with it.
  expect<string>(cn("control-sm", "size-8")).toBe("size-8");
  const both = cn("size-8", "control-sm");
  expect<string>(both).toContain("size-8");
  expect<string>(both).toContain("control-sm");
});

it("a rail beats the per-edge padding groups its own list widens into", () => {
  // `ps`/`pe`/`pbs`/`pbe` are real 3.5.0 groups that BuiltinGroupId cannot even
  // spell; the closure over tailwind-merge's own map covers them.
  expect<string>(cn("ps-2", "rail-lg")).toBe("rail-lg");
});

it("the axis families still compose — disjoint properties AND disjoint vars", () => {
  const result = cn("rail-x-lg", "rail-y-sm");
  expect<string>(result).toContain("rail-x-lg");
  expect<string>(result).toContain("rail-y-sm");
});

// — Tier 3: the real composition shapes ————————————————————————————————————————
//
// The derived table proves less than it looks: a variant-prefixed custom utility
// (`[&_svg]:icon-auto`, how icon-auto reaches almost all of its call sites) is
// keyed by `modifier + group`, so it can never conflict with a bare `size-4` and
// its table rows pass without touching the real shape. These assert
// `cn(BASE, callerClassName)` — how every primitive actually composes.

it("a caller's padding replaces a panel's rail rather than layering on it", () => {
  // OverlayPanel: cn(…, POPOVER_PADDING[padding], …, className).
  expect<string>(cn("rail-lg", "px-2")).toBe("px-2");
});

it("a rail applied over a caller's padding replaces it, so what is published is applied", () => {
  // The reported bug: base-first / className-last used to keep BOTH, so the
  // element advertised --rail-start: lg while px-2 did the padding.
  expect<string>(cn("px-2", "rail-lg")).toBe("rail-lg");
});

it("Card: a caller's axis padding still overrides one axis of p-card", () => {
  // p-card publishes nothing, so this pair legitimately composes — the block
  // padding survives. Making sg-pad mutual with px would silently drop it.
  const result = cn("p-card", "px-2");
  expect<string>(result).toContain("p-card");
  expect<string>(result).toContain("px-2");
});

it("Badge/Row: a caller's p-* replaces the density padding token", () => {
  const result = cn("inline-flex gap-xs p-chip", "p-2");
  expect<string>(result).toBe("inline-flex gap-xs p-2");
});

it("Button: a caller's h-* replaces the control height token", () => {
  expect<string>(cn("control-md", "h-8")).toBe("h-8");
});

it("Button: a caller's px-* / p-* replaces the control padding token", () => {
  expect<string>(cn("px-control-md", "px-0")).toBe("px-0");
  expect<string>(cn("px-control-md", "p-0")).toBe("p-0");
});

it("Button: a caller's pl-* composes with the control padding token", () => {
  // Same relation as built-in px-2.5 → pl-2: both kept, the side wins in CSS.
  const result = cn("px-control-md", "pl-2");
  expect<string>(result).toContain("px-control-md");
  expect<string>(result).toContain("pl-2");
});

it("Button: a caller's gap-* replaces the control gap token", () => {
  expect<string>(cn("gap-control-md", "gap-xs")).toBe("gap-xs");
});

it("Button pill: pill-ends composes with the control padding it widens", () => {
  // pill-ends only sets the per-side extra that px-control-* reads, so the two
  // must survive the merge together, and a caller's px-0 still wins the padding.
  expect<string>(cn("px-control-sm", "pill-ends")).toBe(
    "px-control-sm pill-ends",
  );
  expect<string>(cn("px-control-sm pill-ends", "px-0")).toBe("pill-ends px-0");
  expect<string>(
    cn("rounded-l-full pill-start", "rounded-r-full pill-end"),
  ).toBe("rounded-l-full pill-start rounded-r-full pill-end");
});

it("ToggleChip: the control padding and gap override the chip shell's", () => {
  // Badge's shell carries gap-xs + p-chip; the chip's md form layers the
  // control size's inline padding and gap over them.
  const result = cn("gap-xs p-chip", "px-control-sm gap-control-sm");
  expect<string>(result).toContain("px-control-sm");
  expect<string>(result).toContain("gap-control-sm");
  expect<string>(result).not.toContain("gap-xs");
});

it("SectionCard: rail-x-lg pb-lg composes — different axes", () => {
  const result = cn("rail-x-lg pb-lg");
  expect<string>(result).toContain("rail-x-lg");
  expect<string>(result).toContain("pb-lg");
});

it("data-table: py-row rail-follow composes — different axes", () => {
  const result = cn("py-row rail-follow");
  expect<string>(result).toContain("py-row");
  expect<string>(result).toContain("rail-follow");
});

it("a variant-prefixed icon-auto never conflicts with a bare size-*", () => {
  const result = cn("[&_svg]:icon-auto", "size-4");
  expect<string>(result).toContain("[&_svg]:icon-auto");
  expect<string>(result).toContain("size-4");
});

// — Regressions that must survive the rewiring ————————————————————————————————

it("a text role utility is NOT silently stripped — a trailing text-sm wins via font-size", () => {
  // text-caption extends font-size (not text-color), so the later text-sm (also
  // font-size) deduplicates it instead of both surviving / the role being dropped.
  expect<string>(cn("text-caption", "text-sm")).toBe("text-sm");
});

it("a standalone utility coexists with unrelated classes", () => {
  // focus-ring is standalone (invisible to twMerge); shadow-md is unrelated.
  expect<string>(cn("focus-ring", "shadow-md")).toBe("focus-ring shadow-md");
});

it("rail-bleed and a rail class stay mutually exclusive in both orders", () => {
  // rail-bleed is `extend px`, and every rail group names px, so escaping a region
  // and opening one remain two jobs for two elements.
  expect<string>(cn("rail-lg", "rail-bleed")).toBe("rail-bleed");
  expect<string>(cn("rail-bleed", "rail-lg")).toBe("rail-lg");
});

it("a panel's own backdrop-blur replaces the overlay's themed backdrop, not the reverse", () => {
  // The floating action bar's glass lost its blur when `backdrop-popover`
  // (default `none`) sat beside its `backdrop-blur-[18px]` and won the cascade.
  expect<string>(
    cn("backdrop-popover", "backdrop-blur-[18px] backdrop-saturate-[1.6]"),
  ).toBe("backdrop-blur-[18px] backdrop-saturate-[1.6]");
});
