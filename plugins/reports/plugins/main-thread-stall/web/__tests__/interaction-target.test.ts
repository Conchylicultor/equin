import { afterEach, describe, expect, it } from "vitest";
import { interactionTarget, keyClass } from "../internal/interaction-target";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe("interactionTarget", () => {
  it("resolves an icon inside a button to the button, its label, contribution, pane and owner", () => {
    mount(`
      <div data-lineage="region" data-region-kind="pane" data-region-id="tasks-root" data-region-label="column 1 of 2" data-plugin-id="tasks">
        <span data-lineage="contribution" data-plugin-id="apps-core/surface" data-slot-id="ActionBar.Item" data-contribution-id="">
          <button data-ui-owner="SurfaceModeButton@plugins/x.tsx:12"><svg id="icon"></svg><span>Full screen</span></button>
        </span>
      </div>`);
    expect(
      interactionTarget(document.getElementById("icon"), "click", null),
    ).toEqual({
      kind: "click",
      key: null,
      element: "button — Full screen",
      contribution: "apps-core/surface@ActionBar.Item",
      pane: "tasks#pane:tasks-root",
      owner: "SurfaceModeButton",
    });
  });

  it("never reads a link's or row's text (the user's data), only its label", () => {
    mount(`<a href="/t/1" id="a"><span id="s">My secret task</span></a>`);
    expect(
      interactionTarget(document.getElementById("s"), "click", null).element,
    ).toBe("a");
    mount(`<div role="row" id="r" aria-label="Task row">Secret</div>`);
    expect(
      interactionTarget(document.getElementById("r"), "click", null).element,
    ).toBe("div[role=row] — Task row");
  });

  it("a focus-managed container is not a control", () => {
    mount(`<div tabindex="-1" id="pane"><p id="p">text</p></div>`);
    expect(
      interactionTarget(document.getElementById("p"), "click", null).element,
    ).toBe("p");
  });

  it("the document itself", () => {
    expect(interactionTarget(document, "key", "Escape")).toMatchObject({
      element: "document",
      key: "Escape",
    });
  });
});

describe("keyClass", () => {
  const k = (
    key: string,
    mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {},
  ) =>
    keyClass({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  it("never records what was typed", () => {
    expect(k("a")).toBe("char");
    expect(k("Enter")).toBe("Enter");
    expect(k("k", { metaKey: true })).toBe("Mod+K");
    expect(k("p", { ctrlKey: true, altKey: true })).toBe("Alt+Mod+P");
  });
});
