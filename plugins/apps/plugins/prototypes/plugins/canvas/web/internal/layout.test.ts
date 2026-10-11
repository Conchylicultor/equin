import { describe, expect, it } from "bun:test";
import { layoutFrames, roomPerFrame, sizeForWidth, snapWidth } from "./layout";

describe("roomPerFrame", () => {
  it("shares the width between frames, less padding and gaps", () => {
    expect(roomPerFrame({ w: 1064, h: 900 }, 2)).toEqual({ w: 514, h: 834 });
  });
});

describe("layoutFrames", () => {
  const room = { w: 1000, h: 500 };
  const browserWindow = { w: 1728, h: 990 };

  it("Responsive at Fit fills the room at scale 1", () => {
    expect(
      layoutFrames({
        room,
        browserWindow,
        size: { kind: "responsive" },
        zoom: "fit",
        wholePage: false,
        pageHeight: null,
      }),
    ).toEqual({ width: 1000, height: 500, visibleHeight: 500, scale: 1 });
  });

  it("Responsive at a zoom lays out the room in page pixels", () => {
    expect(
      layoutFrames({
        room,
        browserWindow,
        size: { kind: "responsive" },
        zoom: 0.5,
        wholePage: false,
        pageHeight: null,
      }),
    ).toEqual({ width: 2000, height: 1000, visibleHeight: 1000, scale: 0.5 });
  });

  it("Responsive + Whole page at Fit zooms out until the tallest page fits", () => {
    const l = layoutFrames({
      room,
      browserWindow,
      size: { kind: "responsive" },
      zoom: "fit",
      wholePage: true,
      pageHeight: 2000,
    });
    expect(l.scale).toBe(0.25);
    expect(l.visibleHeight).toBe(2000);
  });

  it("a preset at Fit scales to the room's tighter axis", () => {
    const l = layoutFrames({
      room,
      browserWindow,
      size: { kind: "preset", preset: "Desktop" },
      zoom: "fit",
      wholePage: false,
      pageHeight: null,
    });
    expect(l).toEqual({
      width: 1920,
      height: 1080,
      visibleHeight: 1080,
      scale: 500 / 1080,
    });
  });

  it("This window lays the page out at the browser window's size", () => {
    const l = layoutFrames({
      room,
      browserWindow,
      size: { kind: "window" },
      zoom: "fit",
      wholePage: false,
      pageHeight: null,
    });
    expect(l).toEqual({
      width: 1728,
      height: 990,
      visibleHeight: 990,
      scale: 500 / 990,
    });
  });

  it("a preset with Whole page fits the whole page's height", () => {
    const l = layoutFrames({
      room,
      browserWindow,
      size: { kind: "preset", preset: "Phone" },
      zoom: "fit",
      wholePage: true,
      pageHeight: 2000,
    });
    expect(l.visibleHeight).toBe(2000);
    expect(l.scale).toBe(0.25);
  });

  it("a fixed zoom is the scale, whatever the room", () => {
    const l = layoutFrames({
      room,
      browserWindow,
      size: { kind: "custom", w: 700, h: 600 },
      zoom: 1.5,
      wholePage: false,
      pageHeight: null,
    });
    expect(l.scale).toBe(1.5);
    expect(l.width).toBe(700);
  });
});

describe("snapWidth", () => {
  it("snaps within 28px of a preset it moves toward", () => {
    expect(snapWidth(1420, 1300)).toEqual({ width: 1440, preset: "Laptop" });
    expect(snapWidth(1000, 900)).toEqual({ width: 1000, preset: null });
  });

  it("never pulls a move away from a preset back onto it", () => {
    expect(snapWidth(1441, 1440)).toEqual({ width: 1441, preset: null });
    expect(snapWidth(1460, 1450)).toEqual({ width: 1460, preset: null });
  });

  it("clamps to the slider's range", () => {
    expect(snapWidth(10, 800).width).toBe(360);
    expect(snapWidth(5000, 800).width).toBe(2560);
  });

  it("a width off the presets is a custom size at the current height", () => {
    expect(sizeForWidth(1000, 900, 700)).toEqual({
      kind: "custom",
      w: 1000,
      h: 700,
    });
    expect(sizeForWidth(400, 500, 700)).toEqual({
      kind: "preset",
      preset: "Phone",
    });
  });
});
