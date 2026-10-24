import { expect, test } from "bun:test";
import { Pin, type PinAnchor } from "./pin";

// ---------------------------------------------------------------------------
// Compile-time regression guard for Pin's per-anchor props.
//
// `stretch` and `spanOffset` speak about the anchored edge's PERPENDICULAR
// axis. A corner pins both of its adjacent edges and `center` pins neither, so
// on those anchors the props have nothing to mean — and are a type error rather
// than a prop that is silently ignored.
//
// The mechanism is a GENERIC (`PinProps<T>`) with distributive conditionals,
// deliberately not a discriminated props union: a union cannot accept a
// union-typed discriminant, and `<Pin to={anchor}>` with `anchor: PinAnchor` is
// a real call site (row-actions). A naked type parameter distributes, so the
// whole-union case resolves to `SpaceStep | never` = `SpaceStep` and keeps
// working — which is what the last case below pins down.
//
// Validated by `./equin check type-check`: every `@ts-expect-error` must
// correspond to a real error (tsc fails on an UNUSED directive), and every
// positive case must compile. Nothing here is rendered.
// ---------------------------------------------------------------------------

const _positives = (anchor: PinAnchor) => (
  <>
    {/* Edge-center anchors: both props are available. */}
    <Pin to="top" stretch spanOffset="xs" />
    <Pin to="bottom" spanOffset="none" />
    <Pin to="left" stretch />
    <Pin to="right" spanOffset="lg" />

    {/* Corners and center still take everything that is about the ANCHORED
        edges — this is a narrowing of two props, not of the primitive. */}
    <Pin to="top-right" offset="xs" outset decorative layer="float" />
    <Pin to="center" className="whatever" />

    {/* The union-typed `to` a props union could not express at all. The
        conditional distributes, so `spanOffset` is a plain `SpaceStep` here. */}
    <Pin to={anchor} offset="xs" mask />
    <Pin to={anchor} spanOffset="xs" />
  </>
);

const _negatives = () => (
  <>
    {/* @ts-expect-error a corner has no perpendicular axis to span */}
    <Pin to="top-right" spanOffset="xs" />
    {/* @ts-expect-error a corner has no perpendicular axis to span */}
    <Pin to="bottom-left" stretch />
    {/* @ts-expect-error `center` pins no edge at all */}
    <Pin to="center" spanOffset="xs" />
    {/* @ts-expect-error `center` pins no edge at all */}
    <Pin to="center" stretch />
    {/* @ts-expect-error `spanOffset` is a ramp step, not a length */}
    <Pin to="top" spanOffset="4px" />
  </>
);

test("pin per-anchor props are compile-time only", () => {
  // The assertions above are the test; this keeps the file a valid suite.
  expect(typeof _positives).toBe("function");
  expect(typeof _negatives).toBe("function");
});
