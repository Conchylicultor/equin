import { describe, expect, test } from "bun:test";
import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { isListedApp } from "./resolve-app";

const base = { basePath: "/x", icon: symbol("apps") };
const forEveryone = { app: defineApp({ ...base, id: "a", name: "A" }) };
const forDevelopers = {
  app: defineApp({ ...base, id: "d", name: "D", audience: "developer" }),
};
const unlisted = {
  app: defineApp({ ...base, id: "u", name: "U", listed: false }),
};

describe("isListedApp", () => {
  test("an app for everyone is offered to every audience", () => {
    expect(isListedApp(forEveryone, "user")).toBe(true);
    expect(isListedApp(forEveryone, "developer")).toBe(true);
  });

  test("a developer app is offered only in Developer mode", () => {
    expect(isListedApp(forDevelopers, "user")).toBe(false);
    expect(isListedApp(forDevelopers, "developer")).toBe(true);
  });

  test("an unlisted app is offered to no one", () => {
    expect(isListedApp(unlisted, "user")).toBe(false);
    expect(isListedApp(unlisted, "developer")).toBe(false);
  });
});
