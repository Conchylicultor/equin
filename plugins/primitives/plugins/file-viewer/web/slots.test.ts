import { describe, expect, it } from "bun:test";
import {
  resolveRenderers,
  type FileRendererTarget,
  type RendererMatch,
  type SealedFileRendererContribution,
} from "./slots";

function renderer(
  id: string,
  supports: (t: FileRendererTarget) => RendererMatch,
): SealedFileRendererContribution {
  return {
    id,
    label: id,
    supports,
  } as unknown as SealedFileRendererContribution;
}

const ids = (
  target: FileRendererTarget,
  all: SealedFileRendererContribution[],
) => resolveRenderers(all, target).map((r) => r.contribution.id);

const registry = [
  renderer("fallback", () => "last-resort"),
  renderer("code", ({ file }) =>
    file.path.endsWith(".png") ? false : "fallback",
  ),
  renderer("diff", ({ git }) =>
    git && git.status !== "clean" ? "contextual" : false,
  ),
  renderer("image", ({ file }) =>
    file.path.endsWith(".png") ? "native" : false,
  ),
];

describe("resolveRenderers", () => {
  it("orders offered renderers best tier first", () => {
    expect(
      ids(
        {
          file: { source: "workspace", workspace: "w", path: "a.ts" },
          git: { checkout: "w", path: "a.ts", status: "modified" },
        },
        registry,
      ),
    ).toEqual(["diff", "code"]);
  });

  it("drops a last-resort renderer beside any other", () => {
    expect(ids({ file: { source: "host", path: "/a.png" } }, registry)).toEqual(
      ["image"],
    );
  });

  it("offers the last-resort renderer when nothing else matches", () => {
    const noCode = registry.filter((r) => r.id !== "code");
    expect(ids({ file: { source: "host", path: "/a.zip" } }, noCode)).toEqual([
      "fallback",
    ]);
  });
});
