import { describe, expect, test } from "bun:test";
import { makeArtifactExternal } from "./externals";
import { isBareSpecifier, packageNameOf } from "./constants";

describe("makeArtifactExternal (web artifact of tasks/plugins/task-detail)", () => {
  const external = makeArtifactExternal("tasks/plugins/task-detail", "web");

  test("other plugins' barrels are external", () => {
    expect(external("@plugins/shell/web")).toBe(true);
    expect(external("@plugins/primitives/plugins/pane/web")).toBe(true);
    expect(external("@plugins/tasks/plugins/tasks-core/core")).toBe(true);
  });

  test("own core is ALWAYS external — barrel and deep files alike", () => {
    expect(external("@plugins/tasks/plugins/task-detail/core")).toBe(true);
    expect(
      external("@plugins/tasks/plugins/task-detail/core/internal/util"),
    ).toBe(true);
  });

  test("own shared / own web internals are inlined", () => {
    expect(external("@plugins/tasks/plugins/task-detail/shared")).toBe(false);
    expect(external("@plugins/tasks/plugins/task-detail/shared/protocol")).toBe(
      false,
    );
    expect(
      external("@plugins/tasks/plugins/task-detail/web/components/detail"),
    ).toBe(false);
  });

  test("own SUB-plugins are different plugins — external", () => {
    expect(
      external("@plugins/tasks/plugins/task-detail/plugins/child/web"),
    ).toBe(true);
  });

  test("a sibling whose path shares a prefix is external (prefix ends at '/')", () => {
    expect(external("@plugins/tasks/plugins/task-detail-extra/web")).toBe(true);
  });

  test("bare npm specifiers are external", () => {
    expect(external("react")).toBe(true);
    expect(external("react-dom/client")).toBe(true);
    expect(external("@xyflow/react")).toBe(true);
  });

  test("relative / absolute / virtual ids are never external", () => {
    expect(external("./components/detail")).toBe(false);
    expect(external("../shared/protocol")).toBe(false);
    expect(external("/abs/path.ts")).toBe(false);
    expect(external("\0virtual")).toBe(false);
  });

  test("the registry alias is external (import-map entry)", () => {
    expect(external("@composition-web-registry")).toBe(true);
  });

  test("CSS specifiers stay in-graph (never module URLs)", () => {
    expect(
      external(
        "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css",
      ),
    ).toBe(false);
    expect(external("react-diff-view/style/index.css")).toBe(false);
    expect(external("@xterm/xterm/css/xterm.css")).toBe(false);
    expect(external("katex/dist/katex.min.css")).toBe(false);
  });
});

// The bug this file's rule was rewritten for: a leaf-folder artifact (then the
// layout harness's `fixtures/`, now gone — `prewarm/` stands in) hashes its own
// folder + `shared/`, so anything it inlined from its own `web/` would be
// served forever against sibling code its address never saw.
describe("makeArtifactExternal is per KIND, not a fixed own-core carve-out", () => {
  const own = "primitives/plugins/adaptive-bar";

  test("a prewarm artifact externalises its own web AND core", () => {
    const external = makeArtifactExternal(own, "prewarm");
    expect(external(`@plugins/${own}/web`)).toBe(true);
    expect(external(`@plugins/${own}/web/internal/bar`)).toBe(true);
    expect(external(`@plugins/${own}/core`)).toBe(true);
  });

  test("a prewarm artifact inlines its own prewarm + shared", () => {
    const external = makeArtifactExternal(own, "prewarm");
    expect(external(`@plugins/${own}/prewarm/internal/x`)).toBe(false);
    expect(external(`@plugins/${own}/shared/x`)).toBe(false);
  });

  test("a core artifact externalises its own web and inlines its own core", () => {
    const external = makeArtifactExternal(own, "core");
    expect(external(`@plugins/${own}/web`)).toBe(true);
    expect(external(`@plugins/${own}/core/internal/x`)).toBe(false);
    expect(external(`@plugins/${own}/shared/x`)).toBe(false);
  });

  test("sub-plugins stay external for every kind", () => {
    for (const kind of ["web", "core", "prewarm"]) {
      expect(
        makeArtifactExternal(
          own,
          kind,
        )(`@plugins/${own}/plugins/child/${kind}`),
      ).toBe(true);
    }
  });
});

describe("entry artifact (ownPluginPath null)", () => {
  const external = makeArtifactExternal(null, "entry");
  test("all @plugins barrels external, relatives inlined", () => {
    expect(external("@plugins/framework/plugins/web-sdk/core")).toBe(true);
    expect(external("./App")).toBe(false);
  });
});

describe("specifier helpers", () => {
  test("packageNameOf", () => {
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
    expect(packageNameOf("@xyflow/react/dist/style.css")).toBe("@xyflow/react");
    expect(packageNameOf("react")).toBe("react");
  });
  test("isBareSpecifier", () => {
    expect(isBareSpecifier("react")).toBe(true);
    expect(isBareSpecifier("@scope/pkg/sub")).toBe(true);
    expect(isBareSpecifier("./x")).toBe(false);
    expect(isBareSpecifier("/x")).toBe(false);
    expect(isBareSpecifier("@plugins/a/web")).toBe(false);
  });
});
