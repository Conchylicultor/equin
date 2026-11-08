import { afterEach, describe, expect, test } from "bun:test";
import { onTaskMark, runMarked } from "./task-marks";

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function listen(): string[] {
  const heard: string[] = [];
  uninstall = onTaskMark({
    begin: (source, describe) => {
      heard.push(`begin ${source} ${describe().what}`);
      return heard.length;
    },
    end: (token) => heard.push(token === null ? "end ?" : "end"),
  });
  return heard;
}

const text = (what: string) => () => ({ what, detail: "" });

describe("runMarked", () => {
  test("no listener: runs fn, never describes", () => {
    let described = false;
    const v = runMarked(
      "s",
      () => {
        described = true;
        return { what: "x", detail: "" };
      },
      () => 7,
    );
    expect(v).toBe(7);
    expect(described).toBe(false);
  });

  test("begin before fn; end after the microtasks fn queued itself", async () => {
    const heard = listen();
    runMarked("live-state", text("update a"), () => {
      heard.push("fn");
      queueMicrotask(() => heard.push("fn's microtask"));
    });
    expect(heard).toEqual(["begin live-state update a", "fn"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).toEqual([
      "begin live-state update a",
      "fn",
      "fn's microtask",
      "end",
    ]);
  });

  test("a throwing fn still ends; the error propagates", async () => {
    const heard = listen();
    expect(() =>
      runMarked("s", text("t"), () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    await Promise.resolve();
    expect(heard).toEqual(["begin s t", "end"]);
  });

  test("only the outermost marked task is heard", async () => {
    const heard = listen();
    runMarked("s", text("outer"), () =>
      runMarked("s", text("inner"), () => heard.push("fn")),
    );
    await Promise.resolve();
    expect(heard).toEqual(["begin s outer", "fn", "end"]);
  });

  test("a second listener is refused loudly", () => {
    listen();
    expect(() => onTaskMark({ begin: () => null, end: () => {} })).toThrow(
      "already installed",
    );
  });
});
