import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createJiti } from "jiti";
import type { isBrowserHostSpecifier as IsBrowserHostSpecifier } from "@plugins/framework/plugins/import-map-names/core";
import type { domTestExactInclude as DomTestExactInclude } from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import type { readEnv as ReadEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import type { readFileSync as ReadFileSync } from "@plugins/packages/plugins/timed-fs/core";
import type * as ImageImport from "@plugins/framework/plugins/image-import/core";

// The config loader knows nothing of the tsconfig `@plugins/*` alias, so plugin
// code is loaded through a jiti that does (the same pattern as eslint.config.ts).
// The predicate's own leaf plugin (`framework/import-map-names`, no imports):
// web-artifacts' barrel reaches Bun-only code (`import.meta.dir`), and this
// config runs under Node.
const jiti = createJiti(import.meta.url, {
  alias: { "@plugins": path.resolve(__dirname, "plugins") },
});
export default defineConfig(async () => {
  const { isBrowserHostSpecifier } = await jiti.import<{
    isBrowserHostSpecifier: typeof IsBrowserHostSpecifier;
  }>(
    path.resolve(
      __dirname,
      "plugins/framework/plugins/import-map-names/core/index.ts",
    ),
  );
  // `./equin test` names its exact files: vitest reads every positional
  // argument as a substring filter (`…/live-state` also runs
  // `…/live-state-snapshot`), so an exact selection can only be an `include`.
  // Unset — a bare `vitest` — the scope is the whole jsdom half of the split.
  const { domTestExactInclude } = await jiti.import<{
    domTestExactInclude: typeof DomTestExactInclude;
  }>(
    path.resolve(
      __dirname,
      "plugins/framework/plugins/tooling/plugins/test-layout/core/index.ts",
    ),
  );
  const { readEnv } = await jiti.import<{ readEnv: typeof ReadEnv }>(
    path.resolve(
      __dirname,
      "plugins/infra/plugins/launcher/plugins/env-names/core/index.ts",
    ),
  );
  const { readFileSync } = await jiti.import<{
    readFileSync: typeof ReadFileSync;
  }>(
    path.resolve(__dirname, "plugins/packages/plugins/timed-fs/core/index.ts"),
  );
  const { IMAGE_IMPORT_RE, imageDataUrl, imageModuleCode, importedImageSize } =
    await jiti.import<typeof ImageImport>(
      path.resolve(
        __dirname,
        "plugins/framework/plugins/image-import/core/index.ts",
      ),
    );
  const exactList = readEnv("TEST_DOM_FILES");
  return {
    plugins: [
      // A demo scenario names its browser host as `@browser-host/<plugin>`: a
      // module only a composed dist's import map provides, external to every
      // artifact build. Tests resolve it the same way — left external, by the
      // build's own predicate — so a suite that loads a scenario imports, and one
      // that starts its host fails loudly on the missing module.
      {
        name: "browser-hosts-external",
        enforce: "pre",
        resolveId: (id: string) =>
          isBrowserHostSpecifier(id) ? { id, external: true } : null,
      },
      // An image import is an ImportedImage (`framework/image-import`), as the
      // web build and a Bun render give it — here with a `data:` URL.
      {
        name: "image-imports",
        enforce: "pre",
        load(id: string) {
          if (id.includes("?") || !IMAGE_IMPORT_RE.test(id)) return null;
          const bytes = new Uint8Array(readFileSync(id));
          return imageModuleCode(
            JSON.stringify(imageDataUrl(id, bytes)),
            importedImageSize(id, bytes),
          );
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@plugins": path.resolve(__dirname, "plugins"),
        // Mirror web-core's composition build-gating alias so tests that pull in
        // App.tsx resolve. Tests always use the full registry.
        "@composition-web-registry": path.resolve(
          __dirname,
          "plugins/framework/plugins/web-sdk/core/web.generated.ts",
        ),
      },
    },
    test: {
      environment: "jsdom",
      // The locale and timezone every worker runs in, so a suite that formats a
      // date cannot pass for one runner and fail for another (`LANG=C.UTF-8`
      // renders `M06 17` where a laptop renders `Jun 17`). This is the one place
      // the locale CAN be pinned: it is read once when a process starts, so the
      // setup file is too late — but vitest starts each fork with `test.env` as
      // its environment. `forks` is named because a `threads` worker shares this
      // process, whose locale was fixed before this file ran. `test/setup.ts`
      // asserts the pin arrived; `test-layout:runner-split` rule (g) asserts
      // these three lines survive.
      pool: "forks",
      env: {
        LC_ALL: "en_US.UTF-8",
        TZ: "UTC",
      },
      setupFiles: [path.resolve(__dirname, "test/setup.ts")],
      include:
        exactList === undefined
          ? ["plugins/**/web/__tests__/**/*.test.{ts,tsx}"]
          : domTestExactInclude(readFileSync(exactList, "utf8")),
    },
  };
});
