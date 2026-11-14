import { describe, expect, test } from "bun:test";
import { splitWebBarrel } from "./plugin-definition";

const BARREL = `import { Apps } from "@plugins/apps-core/web";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Layout } from "./components/layout";
import "./internal/register";
import { helper } from "./helper";
export { Band } from "./components/band";
export { helper };
export type { BandProps } from "./components/band";
export interface Shape { a: number }

export default {
  contributions: [Apps.App({ component: Layout })],
} satisfies PluginDefinition;
`;

describe("splitWebBarrel", () => {
  test("the definition keeps every import and the default, and drops the re-exports", async () => {
    const { definition } = await splitWebBarrel({
      source: BARREL,
      filename: "web/index.ts",
      definitionSpecifier: "./__plugin",
    });
    expect(definition).toContain(
      `import { Layout } from "./components/layout";`,
    );
    expect(definition).toContain(`import "./internal/register";`);
    expect(definition).toContain("export default {");
    expect(definition).not.toContain(`export { Band }`);
    expect(definition).not.toContain(`export { helper }`);
    // Types are erased either way.
    expect(definition).toContain("export type { BandProps }");
  });

  test("the barrel re-exports its default from the definition, its API untouched", async () => {
    const { barrel } = await splitWebBarrel({
      source: BARREL,
      filename: "web/index.ts",
      definitionSpecifier: "./__plugin",
    });
    expect(barrel).toContain(`export { default } from "./__plugin";`);
    expect(barrel).not.toContain("export default {");
    expect(barrel).toContain(`export { Band } from "./components/band";`);
    expect(barrel).toContain(`export { helper };`);
  });

  test("a barrel without a default export is refused", async () => {
    let message = "";
    try {
      await splitWebBarrel({
        source: `export { a } from "./a";\n`,
        filename: "web/index.ts",
        definitionSpecifier: "./__plugin",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("must export its plugin definition");
  });
});
