import { describe, expect, it } from "bun:test";
import {
  keyMessage,
  macCommandsFor,
  modifiersOf,
  heldButtonOf,
  mouseButtonOf,
  routeKeyDown,
  wheelPixels,
  type KeyEventLike,
} from "./input-map";

const NONE = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

function key(
  k: string,
  code: string,
  keyCode: number,
  mods: Partial<typeof NONE> = {},
): KeyEventLike {
  return { key: k, code, keyCode, ...NONE, ...mods };
}

describe("modifiersOf", () => {
  it("maps to the CDP bitmask Alt=1 Ctrl=2 Meta=4 Shift=8", () => {
    expect(modifiersOf(NONE)).toBe(0);
    expect(modifiersOf({ ...NONE, altKey: true })).toBe(1);
    expect(modifiersOf({ ...NONE, ctrlKey: true })).toBe(2);
    expect(modifiersOf({ ...NONE, metaKey: true })).toBe(4);
    expect(modifiersOf({ ...NONE, shiftKey: true })).toBe(8);
    expect(
      modifiersOf({
        altKey: true,
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(15);
  });
});

describe("mouseButtonOf", () => {
  it("maps DOM buttons to CDP names", () => {
    expect(mouseButtonOf(0)).toBe("left");
    expect(mouseButtonOf(1)).toBe("middle");
    expect(mouseButtonOf(2)).toBe("right");
    expect(mouseButtonOf(4)).toBe("forward");
    expect(mouseButtonOf(-1)).toBe("none");
  });
});

describe("keyMessage", () => {
  it("a printable key is keyDown with its text", () => {
    expect(keyMessage(key("a", "KeyA", 65), "down", true)).toEqual({
      t: "key",
      type: "keyDown",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      text: "a",
      modifiers: 0,
    });
  });

  it("Enter inserts \\r", () => {
    expect(keyMessage(key("Enter", "Enter", 13), "down", false).text).toBe(
      "\r",
    );
  });

  it("a non-printable key is rawKeyDown with its mac command", () => {
    const msg = keyMessage(
      key("Backspace", "Backspace", 8, { altKey: true }),
      "down",
      true,
    );
    expect(msg.type).toBe("rawKeyDown");
    expect(msg.text).toBe("");
    expect(msg.modifiers).toBe(1);
    expect(msg.commands).toEqual(["deleteWordBackward"]);
  });

  it("Meta+a is rawKeyDown with selectAll on mac, no commands elsewhere", () => {
    const e = key("a", "KeyA", 65, { metaKey: true });
    expect(keyMessage(e, "down", true)).toMatchObject({
      type: "rawKeyDown",
      text: "",
      commands: ["selectAll"],
    });
    expect(keyMessage(e, "down", false).commands).toBeUndefined();
  });

  it("keyUp carries no text and no commands", () => {
    const msg = keyMessage(key("a", "KeyA", 65, { metaKey: true }), "up", true);
    expect(msg.type).toBe("keyUp");
    expect(msg.text).toBe("");
    expect(msg.commands).toBeUndefined();
  });
});

describe("macCommandsFor", () => {
  it("orders modifiers Shift, Control, Alt, Meta", () => {
    expect(
      macCommandsFor("KeyZ", { ...NONE, shiftKey: true, metaKey: true }),
    ).toEqual(["redo"]);
    expect(macCommandsFor("ArrowUp", { ...NONE, altKey: true })).toEqual([
      "moveBackward",
      "moveToBeginningOfParagraph",
    ]);
    expect(macCommandsFor("KeyQ", NONE)).toEqual([]);
  });
});

describe("routeKeyDown", () => {
  it("routes the clipboard shortcuts by platform", () => {
    expect(routeKeyDown(key("v", "KeyV", 86, { metaKey: true }), true)).toBe(
      "paste",
    );
    expect(routeKeyDown(key("c", "KeyC", 67, { metaKey: true }), true)).toBe(
      "copy",
    );
    expect(routeKeyDown(key("x", "KeyX", 88, { ctrlKey: true }), false)).toBe(
      "copy",
    );
    expect(routeKeyDown(key("v", "KeyV", 86, { ctrlKey: true }), true)).toBe(
      "forward-shared",
    );
  });

  it("leaves app shortcuts shared, takes editing keys", () => {
    expect(routeKeyDown(key("k", "KeyK", 75, { metaKey: true }), true)).toBe(
      "forward-shared",
    );
    expect(routeKeyDown(key("a", "KeyA", 65, { metaKey: true }), true)).toBe(
      "forward",
    );
    expect(routeKeyDown(key("a", "KeyA", 65), true)).toBe("forward");
  });
});

describe("wheelPixels", () => {
  it("normalizes delta modes", () => {
    expect(wheelPixels(3, 0, 800)).toBe(3);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(1, 2, 800)).toBe(800);
  });
});

describe("heldButtonOf", () => {
  it("names the held button so a move is a drag", () => {
    expect(heldButtonOf(0)).toBe("none");
    expect(heldButtonOf(1)).toBe("left");
    expect(heldButtonOf(2)).toBe("right");
    expect(heldButtonOf(4)).toBe("middle");
    expect(heldButtonOf(3)).toBe("left");
  });
});
