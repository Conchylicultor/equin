import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  AVATAR_COLORS,
  avatarColorClass,
} from "@plugins/primitives/plugins/avatar/web/testing";
import type {
  FieldDef,
  TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import {
  AvatarCell,
  avatarFieldDef,
  type AvatarFieldData,
} from "../components/avatar-cell";

const field: FieldDef<unknown> = {
  id: "avatar",
  label: "Avatar",
  type: "avatar",
};

function renderCell(data: unknown) {
  const props: TableCellProps = { value: null, data, field };
  return render(<AvatarCell {...props} />);
}

/** The disc is the cell's root span. */
function disc(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("no avatar disc rendered");
  return el;
}

afterEach(cleanup);

describe("AvatarCell", () => {
  it("draws the spec's saved icon as a runtime symbol", () => {
    const { container } = renderCell({ icon: "face", color: "sky" });
    expect(
      disc(container).querySelector('svg[data-icon="face"]'),
    ).not.toBeNull();
  });

  it("applies an explicit colour", () => {
    const { container } = renderCell({ icon: "face", color: "rose" });
    for (const cls of AVATAR_COLORS.rose.split(" ")) {
      expect(disc(container).classList).toContain(cls);
    }
  });

  it("derives the colour from fallbackKey when colour is null", () => {
    for (const fallbackKey of ["agent-a", "agent-b"]) {
      const data: AvatarFieldData = {
        icon: parseSavedSymbolName("face"),
        color: null,
        fallbackKey,
      };
      const { container } = renderCell(data);
      const expected = avatarColorClass(null, fallbackKey);
      expect(expected).not.toBe("bg-muted");
      for (const cls of expected.split(" ")) {
        expect(disc(container).classList).toContain(cls);
      }
      cleanup();
    }
  });

  it("passes the shape through: a squircle, or the default circle", () => {
    const { container } = renderCell({
      icon: null,
      color: "sky",
      shape: "squircle",
    });
    expect(disc(container).classList).toContain("rounded-squircle");
    cleanup();
    const { container: round } = renderCell({
      icon: null,
      color: "sky",
    });
    expect(disc(round).classList).toContain("rounded-full");
  });

  it.each([
    ["undefined", undefined],
    ["an unknown shape", { icon: null, color: null, shape: "hexagon" }],
    ["a string", "face"],
    ["an object missing keys", { icon: "face" }],
    ["a mistyped colour", { icon: "face", color: 3 }],
    ["a mistyped fallbackKey", { icon: null, color: null, fallbackKey: 1 }],
  ])("throws AvatarCellDataError on %s", (_label, data) => {
    // React logs the thrown render error before rethrowing; keep the output clean.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      expect(() => renderCell(data)).toThrow(/avatar cell: field "avatar"/);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("avatarFieldDef", () => {
  interface Row {
    name: string;
  }

  it("declares an avatar-typed field with the projection wired as data", () => {
    const avatar = (row: Row): AvatarFieldData => ({
      icon: null,
      color: null,
      fallbackKey: row.name,
    });
    const def = avatarFieldDef<Row>({
      id: "avatar",
      label: "Avatar",
      avatar,
    });
    expect(def.type).toBe("avatar");
    expect(def.data?.({ name: "x" })).toEqual(avatar({ name: "x" }));
    expect("visible" in def).toBe(false);
  });
});
