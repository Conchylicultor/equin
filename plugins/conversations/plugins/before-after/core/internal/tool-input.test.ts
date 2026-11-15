import { describe, expect, test } from "bun:test";
import { parseRegisterInput, RegisterInputError } from "./tool-input";

describe("parseRegisterInput", () => {
  test("a route is a capture", () => {
    expect(parseRegisterInput({ title: "Agents", route: "/agents" })).toEqual({
      form: "capture",
      title: "Agents",
      route: "/agents",
    });
    expect(
      parseRegisterInput({
        title: "Agents",
        route: "/agents",
        width: 800,
        height: 600,
        colorScheme: "dark",
      }),
    ).toMatchObject({ form: "capture", width: 800, colorScheme: "dark" });
  });

  test("two paths are files", () => {
    expect(
      parseRegisterInput({
        title: "Menu open",
        beforePath: "/tmp/x-before.png",
        afterPath: "/tmp/x-after.png",
        afterLabel: "clicked",
      }),
    ).toEqual({
      form: "files",
      title: "Menu open",
      beforePath: "/tmp/x-before.png",
      afterPath: "/tmp/x-after.png",
      afterLabel: "clicked",
    });
  });

  test("neither, both, or a field of the other form is refused", () => {
    expect(() => parseRegisterInput({ title: "x" })).toThrow(
      RegisterInputError,
    );
    expect(() =>
      parseRegisterInput({
        title: "x",
        route: "/a",
        beforePath: "/b.png",
        afterPath: "/c.png",
      }),
    ).toThrow(/not both/);
    expect(() =>
      parseRegisterInput({ title: "x", route: "/a", beforeLabel: "old" }),
    ).toThrow(RegisterInputError);
    expect(() =>
      parseRegisterInput({ title: "x", beforePath: "/b.png" }),
    ).toThrow(RegisterInputError);
    expect(() => parseRegisterInput({ title: "x", route: "agents" })).toThrow(
      RegisterInputError,
    );
    expect(() => parseRegisterInput({ title: "", route: "/a" })).toThrow(
      RegisterInputError,
    );
  });
});
