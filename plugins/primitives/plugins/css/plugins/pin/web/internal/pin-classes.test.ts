import { describe, expect, test } from "bun:test";
import { pinClasses } from "./pin";

const base = {
  outset: false,
  layer: "raised" as const,
  decorative: false,
  stretch: false,
  spanOffset: "none" as const,
  mask: false,
};

describe("pinClasses", () => {
  test("a corner pins both adjacent edges via inline style", () => {
    expect(pinClasses({ ...base, to: "top-right", offset: "xs" })).toEqual({
      className: "absolute z-raised",
      style: { top: "var(--space-xs)", right: "var(--space-xs)" },
    });
  });

  test("outset negates the offset (overhang the corner)", () => {
    expect(
      pinClasses({ ...base, to: "top-right", offset: "xs", outset: true }),
    ).toEqual({
      className: "absolute z-raised",
      style: {
        top: "calc(var(--space-xs) * -1)",
        right: "calc(var(--space-xs) * -1)",
      },
    });
  });

  test("none offset is a literal 0", () => {
    expect(pinClasses({ ...base, to: "bottom-left", offset: "none" })).toEqual({
      className: "absolute z-raised",
      style: { bottom: "0", left: "0" },
    });
  });

  test("an edge-center pins the edge and centers the perpendicular axis", () => {
    expect(pinClasses({ ...base, to: "left", offset: "sm" })).toEqual({
      className: "absolute z-raised top-1/2 -translate-y-1/2",
      style: { left: "var(--space-sm)" },
    });
    expect(pinClasses({ ...base, to: "bottom", offset: "xs" })).toEqual({
      className: "absolute z-raised left-1/2 -translate-x-1/2",
      style: { bottom: "var(--space-xs)" },
    });
  });

  test("stretch spans the perpendicular axis instead of centering", () => {
    // The span is inline style, not `inset-y-0`/`inset-x-0`: after `spanOffset`
    // every distance a pin emits is a style, so the class list carries only
    // `absolute`, the layer, and the centering trick it did NOT take here.
    expect(
      pinClasses({ ...base, to: "right", offset: "sm", stretch: true }),
    ).toEqual({
      className: "absolute z-raised",
      style: { right: "var(--space-sm)", top: "0", bottom: "0" },
    });
    expect(
      pinClasses({ ...base, to: "top", offset: "none", stretch: true }),
    ).toEqual({
      className: "absolute z-raised",
      style: { top: "0", left: "0", right: "0" },
    });
  });

  test("spanOffset insets the spanned axis from both of its edges", () => {
    expect(
      pinClasses({ ...base, to: "top", offset: "none", spanOffset: "xs" }),
    ).toEqual({
      className: "absolute z-raised",
      style: { top: "0", left: "var(--space-xs)", right: "var(--space-xs)" },
    });
    expect(
      pinClasses({ ...base, to: "left", offset: "sm", spanOffset: "md" }),
    ).toEqual({
      className: "absolute z-raised",
      style: {
        left: "var(--space-sm)",
        top: "var(--space-md)",
        bottom: "var(--space-md)",
      },
    });
  });

  test("spanOffset implies stretch — it never centers", () => {
    // An inset on an axis that is not spanned would be a silent no-op, so asking
    // for one IS asking to span: no `-translate-x-1/2` may survive.
    const { className } = pinClasses({
      ...base,
      to: "bottom",
      offset: "none",
      spanOffset: "lg",
    });
    expect(className).toBe("absolute z-raised");
    expect(className).not.toContain("translate");
  });

  test("spanOffset none is exactly plain stretch", () => {
    expect(
      pinClasses({
        ...base,
        to: "top",
        offset: "xs",
        spanOffset: "none",
        stretch: true,
      }),
    ).toEqual(pinClasses({ ...base, to: "top", offset: "xs", stretch: true }));
  });

  test("outset negates the anchored edge but NOT the spanned axis", () => {
    // `outset` means "overhang the edge you are anchored to"; the spanned axis
    // has no anchor to overhang, so its inset stays positive.
    expect(
      pinClasses({
        ...base,
        to: "top",
        offset: "sm",
        spanOffset: "xs",
        outset: true,
      }),
    ).toEqual({
      className: "absolute z-raised",
      style: {
        top: "calc(var(--space-sm) * -1)",
        left: "var(--space-xs)",
        right: "var(--space-xs)",
      },
    });
  });

  test("a corner and center emit no span inset at all", () => {
    expect(
      pinClasses({ ...base, to: "bottom-left", offset: "xs" }).style,
    ).toEqual({
      bottom: "var(--space-xs)",
      left: "var(--space-xs)",
    });
    expect(pinClasses({ ...base, to: "center", offset: "xs" }).style).toEqual(
      {},
    );
  });

  test("center is the four-class translate trick and ignores offset", () => {
    expect(pinClasses({ ...base, to: "center", offset: "lg" })).toEqual({
      className:
        "absolute z-raised top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
      style: {},
    });
  });

  test("mask pins flush, spans the perpendicular axis, and pays the offset as padding", () => {
    const { className, style } = pinClasses({
      ...base,
      to: "right",
      offset: "xs",
      mask: true,
    });
    // Flush + full-height: a scrim inset from the edge it hides against leaves a
    // live sliver of content showing in the gap, and one only as tall as the
    // button cluster leaves the row's text peeking above and below it.
    expect(className).toBe(
      "absolute z-raised flex items-center justify-center",
    );
    expect(style.right).toBe("0");
    expect(style.top).toBe("0");
    expect(style.bottom).toBe("0");
    expect(style.paddingRight).toBe("var(--space-xs)");
    // Left padding clears the ramp, so the buttons sit where the mask is fully
    // opaque — the fade dissolves the covered content, never the icons.
    expect(style.paddingLeft).toBe("calc(var(--space-xs) + 1.5rem)");
    // The row's tint layered over the surface, so a translucent hover tint
    // still hides what the scrim covers.
    expect(style.backgroundColor).toBe("var(--chrome-mask)");
    expect(style.backgroundImage).toBe(
      "linear-gradient(var(--scrim, transparent), var(--scrim, transparent))",
    );
    expect(style.borderRadius).toBe("inherit");
    expect(style.maskImage).toBe(
      "linear-gradient(to right, transparent, black 1.5rem)",
    );
  });

  test("a masked corner ramps BOTH inward edges and intersects them", () => {
    const { style } = pinClasses({
      ...base,
      to: "top-right",
      offset: "sm",
      mask: true,
    });
    expect(style.top).toBe("0");
    expect(style.right).toBe("0");
    // Anchored top-right ⇒ the inward edges are the left and the BOTTOM, so each
    // ramp runs from its own outward edge back toward the anchor.
    expect(style.maskImage).toBe(
      "linear-gradient(to right, transparent, black 1.5rem), " +
        "linear-gradient(to top, transparent, black 1.5rem)",
    );
    // Opaque only where NEITHER ramp is fading.
    expect(style.maskComposite).toBe("intersect");
    expect(style.paddingTop).toBe("var(--space-sm)");
    expect(style.paddingBottom).toBe("calc(var(--space-sm) + 1.5rem)");
  });

  test("mask forces the span flush while still paying the offset as padding", () => {
    // A gap along the SPANNED axis is exactly the live sliver the scrim exists to
    // cover, so — unlike `offset` — the span offset is not re-expressed as
    // padding; it is simply overruled.
    const { className, style } = pinClasses({
      ...base,
      to: "top",
      offset: "sm",
      spanOffset: "lg",
      mask: true,
    });
    expect(className).toBe(
      "absolute z-raised flex items-center justify-center",
    );
    expect(style.left).toBe("0");
    expect(style.right).toBe("0");
    expect(style.paddingLeft).toBeUndefined();
    expect(style.paddingRight).toBeUndefined();
    // The ANCHORED edge still pays its offset as padding, as it always has.
    expect(style.top).toBe("0");
    expect(style.paddingTop).toBe("var(--space-sm)");
    expect(style.paddingBottom).toBe("calc(var(--space-sm) + 1.5rem)");
  });

  test("an unmasked pin paints nothing (the pre-existing anchors are untouched)", () => {
    const { style } = pinClasses({ ...base, to: "right", offset: "xs" });
    expect(style.backgroundColor).toBeUndefined();
    expect(style.backgroundImage).toBeUndefined();
    expect(style.maskImage).toBeUndefined();
    expect(style.right).toBe("var(--space-xs)");
  });

  test("decorative adds pointer-events-none; layer maps to a z-class", () => {
    expect(
      pinClasses({
        ...base,
        to: "top-left",
        offset: "none",
        decorative: true,
        layer: "overlay",
      }),
    ).toEqual({
      className: "absolute z-overlay pointer-events-none",
      style: { top: "0", left: "0" },
    });
  });
});
