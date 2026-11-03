// The artifact builder's Babel pass: the `vite/` contributions (web-core's
// `loadBabelContributions` — the React Compiler, element-picker's source
// stamps) run on exactly the modules their `appliesTo` accepts, and a module
// none applies to never goes through Babel at all.
//
// Why not `@vitejs/plugin-react`: in a production build it is only this pass
// plus the automatic JSX runtime for oxc, and it runs Babel on EVERY
// `.ts`/`.tsx` module whenever any plugin is configured. Babel was the biggest
// cost of a cold artifact build (~35 of ~65 ms an artifact, measured
// 2026-11-02), and about half the shipped source bytes are `.ts` files no
// contribution can change: a full parse + regenerate for an identical result.
// The options below are plugin-react 5.2's for a production build, so a module
// that does go through Babel comes out byte-identical to before.

import type { TransformOptions } from "@babel/core";
import type { Plugin as VitePlugin } from "vite";
import {
  babelPluginsFor,
  type OrderedBabelContributions,
} from "@plugins/framework/plugins/web-core/core";

const SOURCE_RE = /\.[tj]sx?$/;
const NODE_MODULES_RE = /\/node_modules\//;
const TS_RE = /\.tsx?$/;

export function babelContributionsPlugin(
  contributions: OrderedBabelContributions,
): VitePlugin {
  let projectRoot = process.cwd();
  return {
    name: "web-artifacts:babel-contributions",
    enforce: "pre",
    // What plugin-react sets for a rolldown-vite build: oxc lowers JSX with
    // the automatic runtime (`react/jsx-runtime`), never refreshed.
    config: () => ({
      oxc: { jsx: { runtime: "automatic", refresh: false } },
    }),
    configResolved(config) {
      projectRoot = config.root;
    },
    transform: {
      filter: { id: { include: SOURCE_RE, exclude: NODE_MODULES_RE } },
      async handler(code, id) {
        const plugins = babelPluginsFor(contributions, { id, code });
        if (plugins.length === 0) return;
        const filepath = id.split("?")[0]!;
        const parserPlugins: Array<"jsx" | "typescript"> = [];
        if (!filepath.endsWith(".ts")) parserPlugins.push("jsx");
        if (TS_RE.test(filepath)) parserPlugins.push("typescript");
        // Lazy: Babel loads only when a module needs it.
        const babel = await import("@babel/core");
        const options: TransformOptions = {
          babelrc: false,
          configFile: false,
          root: projectRoot,
          filename: id,
          sourceFileName: filepath,
          retainLines: false,
          parserOpts: {
            sourceType: "module",
            allowAwaitOutsideFunction: true,
            plugins: parserPlugins,
          },
          generatorOpts: {
            importAttributesKeyword: "with",
            decoratorsBeforeExport: true,
          },
          plugins,
          sourceMaps: true,
        };
        const result = await babel.transformAsync(code, options);
        if (result?.code == null) {
          throw new Error(`babel returned no code for ${id}`);
        }
        return { code: result.code, map: result.map };
      },
    },
  };
}
