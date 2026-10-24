import { describe, expect, test } from "bun:test";
import { ASSET_PATH } from "@plugins/infra/plugins/endpoints/core";
import {
  assetMirrorBase,
  getMirroredFile,
  getMirroredNestedFile,
} from "./endpoints";
import { ASSET_MIRROR_PREFIX, assetMirrorUrl } from "./url";

describe("asset-mirror addresses", () => {
  test("the page-only string base is the declared routes' prefix", () => {
    expect(getMirroredFile.path).toBe(`${ASSET_MIRROR_PREFIX}/:id/:file`);
    expect(getMirroredNestedFile.path).toBe(
      `${ASSET_MIRROR_PREFIX}/:id/:dir/:file`,
    );
    expect(assetMirrorBase("emojibase")[ASSET_PATH]).toBe(
      assetMirrorUrl("emojibase"),
    );
  });

  test("the base is desktop-only", () => {
    expect(assetMirrorBase("x").needsMachine).toEqual({
      feature: "The asset mirror",
    });
  });
});
