import { describe, expect, test } from "bun:test";
import {
  composedWebPlugins,
  declareComposedWebPlugins,
  keepComposed,
  type ComposedEntry,
} from "./composed-web-plugins";

const entries: ComposedEntry<string>[] = [
  { plugin: "apps.sonata.shell", value: "sonata" },
  { plugin: "apps.website.shell", value: "website" },
  { plugin: "apps.home.shell", value: "home" },
];

describe("composed web plugins", () => {
  test("keeps the entries of the composition's web plugins, in manifest order", () => {
    expect(
      keepComposed(entries, new Set(["apps.home.shell", "apps.sonata.shell"])),
    ).toEqual(["sonata", "home"]);
  });

  test("an entry of a plugin the composition does not load is dropped", () => {
    expect(keepComposed(entries, new Set(["apps.website.shell"]))).toEqual([
      "website",
    ]);
  });

  // No suite declares a composition (only `serve` and `exec` do), so the read
  // is still undeclared here — and says so rather than answering every plugin.
  test("a read before the process declared its composition throws", () => {
    expect(() => composedWebPlugins()).toThrow(/before the process declared/);
  });
});

describe("declaring", () => {
  // Never declares a real set: a declaration is process-wide.
  test("a registry with no webPlugins (written before the field) is refused", () => {
    expect(() => declareComposedWebPlugins(undefined)).toThrow(
      /states no `composition.webPlugins`/,
    );
  });
});
