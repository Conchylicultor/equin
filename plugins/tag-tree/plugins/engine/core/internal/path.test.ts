import { expect, test } from "bun:test";
import { parseTagPath, resolveTagPath } from "./path";
import type { NamedTagNode } from "./tree";

function tag(
  id: string,
  name: string,
  parentId: string | null,
  rank = "a0",
): NamedTagNode {
  return { id, name, parentId, rank, color: null, childColors: null };
}

const TAGS = [
  tag("app", "app", null),
  tag("web", "Website", "app"),
  tag("home", "homepage", "web"),
  tag("infra", "infra", null, "a1"),
  // Same name under another parent: the walk must follow the path, not the name.
  tag("infra-web", "website", "infra"),
];

test("parseTagPath splits on /, trims, drops empties", () => {
  expect(parseTagPath(" app / website //homepage/ ")).toEqual([
    "app",
    "website",
    "homepage",
  ]);
  expect(parseTagPath("  ")).toEqual([]);
  expect(parseTagPath("solo")).toEqual(["solo"]);
});

test("resolveTagPath walks from the root, case-insensitively", () => {
  expect(resolveTagPath(["APP", "website", "Homepage"], TAGS)).toEqual([
    { name: "APP", tagId: "app" },
    { name: "website", tagId: "web" },
    { name: "Homepage", tagId: "home" },
  ]);
  expect(resolveTagPath(["infra", "website"], TAGS)).toEqual([
    { name: "infra", tagId: "infra" },
    { name: "website", tagId: "infra-web" },
  ]);
});

test("resolveTagPath: a missing segment and every later one are to create", () => {
  expect(resolveTagPath(["app", "chord", "homepage"], TAGS)).toEqual([
    { name: "app", tagId: "app" },
    { name: "chord", tagId: null },
    // "homepage" exists, but not under a tag that does not exist yet.
    { name: "homepage", tagId: null },
  ]);
  expect(resolveTagPath(["website"], TAGS)).toEqual([
    { name: "website", tagId: null },
  ]);
  expect(resolveTagPath([], TAGS)).toEqual([]);
});
