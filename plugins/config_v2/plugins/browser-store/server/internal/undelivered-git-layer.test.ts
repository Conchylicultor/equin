import { expect, test } from "bun:test";
import { undeliveredGitLayer } from "./undelivered-git-layer";

test("the undelivered committed layer throws naming the path and the next step", () => {
  expect(() =>
    undeliveredGitLayer.hasScope("apps/theme/theme.jsonc", "pages"),
  ).toThrow(
    /committed layer not delivered to this host \(storePath "apps\/theme\/theme\.jsonc", app "pages"\).*deliver @composition-config-layer/,
  );
});
