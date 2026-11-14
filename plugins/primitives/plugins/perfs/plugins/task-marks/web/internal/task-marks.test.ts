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

  test("a nested mark names the chain; the outer one is begun again after it", async () => {
    const heard: string[] = [];
    let next = 0;
    uninstall = onTaskMark({
      begin: (source, describe) => {
        const t = describe();
        heard.push(`begin#${next} ${source} ${t.what} [${t.detail}]`);
        return next++;
      },
      end: (token) => heard.push(`end#${token}`),
    });
    runMarked(
      "networking",
      () => ({ what: "rx", detail: "12 B" }),
      () => {
        runMarked(
          "networking",
          () => ({ what: "dispatch", detail: "" }),
          () =>
            runMarked(
              "live-state",
              () => ({ what: "update a", detail: "p=1" }),
              () => heard.push("fn"),
            ),
        );
        heard.push("after");
      },
    );
    await Promise.resolve();
    expect(heard).toEqual([
      "begin#0 networking rx [12 B]",
      "begin#1 networking rx > dispatch [12 B]",
      "begin#2 networking rx > dispatch > live-state:update a [p=1]",
      "fn",
      "end#2",
      "begin#3 networking rx > dispatch [12 B]",
      "end#3",
      "begin#4 networking rx [12 B]",
      "after",
      "end#4",
    ]);
  });

  test("each describe runs at most once, however often its task is begun again", () => {
    let outer = 0;
    listen();
    runMarked(
      "s",
      () => {
        outer++;
        return { what: "outer", detail: "" };
      },
      () => {
        runMarked("s", text("a"), () => {});
        runMarked("s", text("b"), () => {});
      },
    );
    expect(outer).toBe(1);
  });

  test("nested marks without a listener never describe", () => {
    let described = 0;
    const d = () => {
      described++;
      return { what: "x", detail: "" };
    };
    runMarked("s", d, () =>
      runMarked("s", d, () => runMarked("s", d, () => {})),
    );
    expect(described).toBe(0);
  });

  test("a throwing inner task still ends and re-begins the outer", async () => {
    const heard = listen();
    runMarked("s", text("outer"), () => {
      expect(() =>
        runMarked("s", text("inner"), () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
    });
    await Promise.resolve();
    expect(heard).toEqual([
      "begin s outer",
      "begin s outer > inner",
      "end",
      "begin s outer",
      "end",
    ]);
  });

  test("a second listener is refused loudly", () => {
    listen();
    expect(() => onTaskMark({ begin: () => null, end: () => {} })).toThrow(
      "already installed",
    );
  });
});
