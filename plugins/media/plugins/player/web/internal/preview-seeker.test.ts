import { describe, expect, it } from "bun:test";
import { createPreviewSeeker, type Seekable } from "./preview-seeker";

function fakeElement(readyState = 1) {
  const listeners = new Map<string, Set<() => void>>();
  const writes: number[] = [];
  const el: Seekable & { fire(type: string): void } = {
    readyState,
    get currentTime() {
      return writes.at(-1) ?? 0;
    },
    set currentTime(t: number) {
      writes.push(t);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
  return { el, writes };
}

describe("createPreviewSeeker", () => {
  it("issues at once when idle, keeps only the latest target while busy", () => {
    const { el, writes } = fakeElement();
    const s = createPreviewSeeker(el);
    s.seek(1);
    s.seek(2);
    s.seek(3);
    expect(writes).toEqual([1]);
    el.fire("seeked");
    expect(writes).toEqual([1, 3]);
    el.fire("seeked");
    s.seek(4);
    expect(writes).toEqual([1, 3, 4]);
  });

  it("waits for metadata before the first seek", () => {
    const { el, writes } = fakeElement(0);
    const s = createPreviewSeeker(el);
    s.seek(5);
    s.seek(6);
    expect(writes).toEqual([]);
    el.readyState = 1;
    el.fire("loadedmetadata");
    expect(writes).toEqual([6]);
  });

  it("stops listening once disposed", () => {
    const { el, writes } = fakeElement();
    const s = createPreviewSeeker(el);
    s.seek(1);
    s.seek(2);
    s.dispose();
    el.fire("seeked");
    expect(writes).toEqual([1]);
  });
});
