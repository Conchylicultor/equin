import { expect, test } from "bun:test";
import { HARNESS_ROOT, PageInputError, pageInputs } from "./page-inputs";

const H = HARNESS_ROOT;

function fakeRepo(files: Record<string, string>) {
  const paths = Object.keys(files).sort();
  return {
    has: (p: string) => p in files,
    read: async (p: string) => files[p] ?? null,
    under: (dir: string) => paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: (_pattern: string) => paths.filter((p) => p.includes("/exhibits/")),
  };
}

const FILES: Record<string, string> = {
  "bun.lock": "lock",
  [`${H}/web/internal/entry.tsx`]: `import { Text } from "@plugins/primitives/plugins/css/plugins/text/web"; import "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css"; Text;`,
  [`${H}/check/index.ts`]: `import { spawn } from "@plugins/infra/plugins/spawn/core"; spawn;`,
  "plugins/infra/plugins/spawn/core/index.ts": "export const spawn = 1;",
  "plugins/primitives/plugins/css/plugins/text/web/index.ts": `import { a } from "./internal/a"; export const Text = a;`,
  "plugins/primitives/plugins/css/plugins/text/web/internal/a.ts":
    "export const a = 1;",
  "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css": `@import "tailwindcss"; @import "./tokens.css";`,
  "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/tokens.css":
    ":root{}",
  "plugins/hints/exhibits/index.ts": `import { appExhibit } from "@plugins/primitives/plugins/css/plugins/text/web"; export default appExhibit({ load: () => import("../web/big") });`,
  "plugins/hints/web/big.ts": "export default 1;",
  "plugins/hints/web/unrelated.ts": "export default 2;",
};

test("the closure: static imports, stylesheets, exhibits barrels — not an app exhibit's load(), not the check's own imports", async () => {
  const { files } = await pageInputs(fakeRepo(FILES));
  expect(files).toEqual(
    [
      "bun.lock",
      `${H}/check/index.ts`,
      `${H}/web/internal/entry.tsx`,
      "plugins/hints/exhibits/index.ts",
      "plugins/primitives/plugins/css/plugins/text/web/index.ts",
      "plugins/primitives/plugins/css/plugins/text/web/internal/a.ts",
      "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css",
      "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/tokens.css",
    ].sort(),
  );
});

test("an import it cannot place fails the key", async () => {
  const files = {
    ...FILES,
    "plugins/primitives/plugins/css/plugins/text/web/internal/a.ts": `import "./gone"; export const a = 1;`,
  };
  expect(pageInputs(fakeRepo(files))).rejects.toThrow(PageInputError);
});
