import { describe, expect, test } from "bun:test";
import type { ServerRegistryEntry } from "./boot-stages";
import { missingContributors, resolveStartSet } from "./start-set";

function entry(
  pluginPath: string,
  dependsOn: string[] = [],
  machine = false,
): ServerRegistryEntry {
  const id = pluginPath.split("/plugins/").join(".");
  return {
    pluginPath,
    id: machine ? `${id}#machine` : id,
    loader: () => Promise.resolve({ default: {} }),
    dependsOn,
    core: null,
  };
}

// a ─▶ b, b's machine half ─▶ c; d contributes the list "l" (machine half),
// e provides host service "svc"; f is unrelated.
const entries = [
  entry("a", ["b"]),
  entry("b"),
  entry("b", ["c"], true),
  entry("c"),
  entry("d"),
  entry("d", [], true),
  entry("e"),
  entry("f"),
];
const contributors = {
  l: ["d#machine", "outside/plugins/x"],
  "host-service:svc": ["e"],
};

const nodes = (set: ReturnType<typeof resolveStartSet>) =>
  [...set.why.keys()].sort();

describe("resolveStartSet", () => {
  test("a root, what it imports, and every plugin whole", () => {
    const set = resolveStartSet({
      entries,
      roots: ["a"],
      reads: [],
      contributors,
    });
    expect(nodes(set)).toEqual(["a", "b", "b#machine", "c"]);
    expect(set.why.get("b#machine")).toBe("machine half of b");
    expect(set.why.get("c")).toBe("imported by b#machine");
    expect(set.entries.map((e) => e.id)).toEqual(["a", "b", "b#machine", "c"]);
  });

  test("a read list starts its contributors in this registry, whole", () => {
    const set = resolveStartSet({
      entries,
      roots: ["a"],
      reads: ["l"],
      contributors,
    });
    expect(nodes(set)).toEqual(["a", "b", "b#machine", "c", "d#machine"]);
    expect(set.why.get("d#machine")).toBe("contributes l");
  });

  test("a missing host service starts its one provider", () => {
    const set = resolveStartSet({
      entries,
      roots: ["a"],
      reads: [],
      hostServices: ["svc"],
      contributors,
    });
    expect(set.why.get("e")).toBe("provides svc");
    expect(() =>
      resolveStartSet({
        entries,
        roots: ["a"],
        reads: [],
        hostServices: ["nobody"],
        contributors,
      }),
    ).toThrow(/0 providers/);
  });

  test("a root with only a machine half, and an unknown root", () => {
    const set = resolveStartSet({
      entries: [entry("m", [], true)],
      roots: ["m"],
      reads: [],
      contributors: {},
    });
    expect(nodes(set)).toEqual(["m#machine"]);
    expect(() =>
      resolveStartSet({ entries, roots: ["nope"], reads: [], contributors }),
    ).toThrow(/no server or machine half/);
  });

  test("follow keeps only the edges it accepts", () => {
    const set = resolveStartSet({
      entries,
      roots: ["a"],
      reads: [],
      contributors,
      follow: (n) => n !== "b#machine",
    });
    expect(nodes(set)).toEqual(["a", "b"]);
  });
});

describe("missingContributors", () => {
  test("names the registry's contributors not started, ignoring other compositions'", () => {
    const registry = new Set(["a", "d#machine"]);
    expect(
      missingContributors(contributors, "l", registry, new Set(["a"])),
    ).toEqual(["d#machine"]);
    expect(
      missingContributors(contributors, "l", registry, new Set(["d#machine"])),
    ).toEqual([]);
    expect(
      missingContributors(contributors, "none", registry, new Set()),
    ).toEqual([]);
  });
});
