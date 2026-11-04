/**
 * Tests for the `endpoints/no-asset-path-read` lint rule: an `AssetPath`'s
 * path is read only by the endpoints plugin itself.
 */

import rule from "./no-asset-path-read";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const WEB = "/repo/plugins/x/web/components/x.tsx";

ruleTester.run("no-asset-path-read", rule, {
  valid: [
    {
      filename: WEB,
      code: `import { assetPath, type AssetPath } from "@plugins/infra/plugins/endpoints/core";`,
    },
    {
      filename: "/repo/plugins/x/core/internal/x.test.ts",
      code: `import { ASSET_PATH } from "@plugins/infra/plugins/endpoints/core";`,
    },
    {
      filename:
        "/repo/plugins/infra/plugins/endpoints/web/internal/asset-src.ts",
      code: `import { ASSET_PATH } from "../../core";`,
    },
  ],
  invalid: [
    {
      filename: WEB,
      code: `import { ASSET_PATH, assetPath } from "@plugins/infra/plugins/endpoints/core";`,
      errors: [{ messageId: "assetPathRead" }],
    },
    {
      filename: "/repo/plugins/x/core/internal/x.ts",
      code: `import * as e from "@plugins/infra/plugins/endpoints/core";\nconst p = a[e.ASSET_PATH];`,
      errors: [{ messageId: "assetPathRead" }],
    },
  ],
});
