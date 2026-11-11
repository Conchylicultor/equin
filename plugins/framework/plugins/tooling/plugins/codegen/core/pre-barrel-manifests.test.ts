import { describe, expect, test } from "bun:test";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import {
  compositionManifestPath,
  compositionManifestRedirects,
  postWebManifests,
} from "./pre-barrel-manifests";

const root = asAppPath("/repo");
const perComposition = postWebManifests.filter((m) => m.perComposition);

describe("per-composition post-web manifests", () => {
  test("the app and theme declarations are per composition", () => {
    expect(perComposition.map((m) => m.id).sort()).toEqual([
      "appDeclarations",
      "themeDeclarations",
    ]);
  });

  test("a composition's copy sits beside the committed file, spelled like its registries", () => {
    const apps = perComposition.find((m) => m.id === "appDeclarations")!;
    expect(compositionManifestPath(apps, root, "website")).toBe(
      asAppPath(
        "/repo/plugins/apps-core/server/internal/apps.composition.website.generated.ts",
      ),
    );
    expect(compositionManifestPath(apps, root, MAIN_COMPOSITION_ID)).toBe(
      apps.path(root),
    );
  });

  test("a release redirects each committed copy to the composition's, and main's to nothing", () => {
    expect(compositionManifestRedirects(root, "website")).toEqual(
      perComposition.map((m) => ({
        committed: m.path(root),
        filtered: compositionManifestPath(m, root, "website"),
      })),
    );
    expect(compositionManifestRedirects(root, MAIN_COMPOSITION_ID)).toEqual([]);
  });
});
