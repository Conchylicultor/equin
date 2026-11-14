import { describe, expect, test } from "bun:test";
import {
  bundleLinkGraph,
  linkKey,
  planLinkGraph,
  type LinkInputs,
  type LinkIo,
} from "./link";

// A fleet as the builder emits it (`preserveModules`): each artifact a dir of
// modules, its barrel an `index.js` facade, a web barrel's definition
// `__plugin.js`. Cross-plugin imports still name barrels by specifier.
const FILES: Record<string, string> = {
  // The entry boots every registry loader.
  "/s/entry.e/index.js": `import{webEntries as w}from"@composition-web-registry";export const boot=()=>Promise.all(w.map(e=>e.loader()));`,
  "/s/reg.r/index.js":
    `export const webEntries=[` +
    `{pluginPath:"a",loader:()=>import("@plugins/a/web")},` +
    `{pluginPath:"kit",loader:()=>import("@plugins/kit/web")},` +
    `{pluginPath:"apps/plugins/x/plugins/page",loader:()=>import("@plugins/apps/plugins/x/plugins/page/web")},` +
    `{pluginPath:"apps/plugins/y/plugins/page",loader:()=>import("@plugins/apps/plugins/y/plugins/page/web")}];`,

  // A ui kit: its barrel re-exports a light helper and a heavy component
  // through an intermediate module (two hops).
  "/s/kit.web/index.js": `import{cn as t}from"./web/cn.js";import{Menu as m}from"./web/components/index.js";export{default}from"./__plugin.js";export{t as cn,m as Menu};`,
  "/s/kit.web/__plugin.js": `export default {contributions:[]};`,
  "/s/kit.web/web/cn.js": `export function cn(...c){return c.join(" ")}`,
  "/s/kit.web/web/components/index.js": `export{Menu}from"./menu.js";`,
  "/s/kit.web/web/components/menu.js": `import{Popup}from"menu-vendor";console.log("menu evaluated");export function Menu(){return Popup}`,

  // An eager plugin using only the helper, and a core helper of `d`.
  "/s/a.web/index.js": `export{default}from"./__plugin.js";`,
  "/s/a.web/__plugin.js": `import{cn}from"@plugins/kit/web";import{helper as h}from"@plugins/d/core";export default {contributions:[cn("x"),h()]};`,

  // A core barrel: a helper, and a module declaring a boot-preloaded
  // descriptor that nothing imports by name.
  "/s/d.core/index.js": `export{helper}from"./core/helper.js";export{desc}from"./core/desc.js";`,
  "/s/d.core/core/helper.js": `export const helper=()=>1;`,
  "/s/d.core/core/desc.js": `export const desc=register("k",{preload:"boot"});function register(k,s){globalThis.r=(globalThis.r||[]).concat(k);return s}`,

  // Two apps' deferred pages: both use the heavy component; x has an image.
  "/s/x.web/index.js": `export{default}from"./__plugin.js";`,
  "/s/x.web/__plugin.js": `import{Menu}from"@plugins/kit/web";const img=new URL("./web/shot.png",import.meta.url).href;export default {contributions:[Menu,img]};`,
  "/s/y.web/index.js": `export{default}from"./__plugin.js";`,
  "/s/y.web/__plugin.js": `import{Menu}from"@plugins/kit/web";export default {contributions:[Menu]};`,
};

const io: LinkIo = {
  storePath: (dirName) => `/s/${dirName}`,
  read: (file) => FILES[file] ?? null,
};

const web = (dirName: string, pluginPath: string) => ({
  dirName,
  specifier: `@plugins/${pluginPath}/web`,
  kind: "web",
  pluginPath,
  coEntries: [],
});

function inputs(over: Partial<LinkInputs> = {}): LinkInputs {
  return {
    identityHash: "id",
    minify: false,
    entryDirName: "entry.e",
    registryDirName: "reg.r",
    artifacts: [
      web("kit.web", "kit"),
      web("a.web", "a"),
      web("x.web", "apps/plugins/x/plugins/page"),
      web("y.web", "apps/plugins/y/plugins/page"),
      {
        dirName: "d.core",
        specifier: "@plugins/d/core",
        kind: "core",
        pluginPath: "d",
        coEntries: [],
      },
    ],
    isExternal: (spec) => spec === "menu-vendor",
    vendorSetHash: "v",
    eager: new Set(["kit", "a"]),
    appPlugins: {
      "apps/plugins/x/": ["apps/plugins/x/plugins/page"],
      "apps/plugins/y/": ["apps/plugins/y/plugins/page"],
    },
    pageScripts: [],
    ...over,
  };
}

describe("planLinkGraph", () => {
  test("a named import loads the module defining it, through every re-export hop", async () => {
    const g = await planLinkGraph(inputs(), io);
    const a = g.linked.get("/s/a.web/__plugin.js")!;
    expect(a.code).toContain(`import{cn}from"/s/kit.web/web/cn.js";`);
    expect(a.code).toContain(
      `import{helper as h}from"/s/d.core/core/helper.js";`,
    );
    expect(a.statics).not.toContain("/s/kit.web/index.js");
    const x = g.linked.get("/s/x.web/__plugin.js")!;
    // Two hops: index.js → components/index.js → menu.js.
    expect(x.code).toContain(
      `import{Menu}from"/s/kit.web/web/components/menu.js";`,
    );
    expect(g.elided).toBeGreaterThanOrEqual(3);
  });

  test("the registry loads each web barrel's definition, never the barrel", async () => {
    const g = await planLinkGraph(inputs(), io);
    const reg = g.linked.get("/s/reg.r/index.js")!;
    expect(reg.dynamics).toContain("/s/a.web/__plugin.js");
    expect(reg.dynamics).not.toContain("/s/kit.web/index.js");
    // The barrels themselves were never reached.
    expect(g.linked.has("/s/kit.web/index.js")).toBe(false);
  });

  test("boot holds what the eager plugins import, not what only an app page does", async () => {
    const g = await planLinkGraph(inputs(), io);
    expect(g.boot.has("/s/kit.web/web/cn.js")).toBe(true);
    expect(g.boot.has("/s/kit.web/web/components/menu.js")).toBe(false);
  });

  test("a module two apps reach is grouped by the set of them, in neither app's own group", async () => {
    const g = await planLinkGraph(inputs(), io);
    expect(g.appGroupOf.get("/s/kit.web/web/components/menu.js")).toBe(
      "apps/plugins/x/+apps/plugins/y/",
    );
    expect(g.appGroupOf.get("/s/x.web/__plugin.js")).toBe("apps/plugins/x/");
  });

  test("a boot-preloaded descriptor the boot's barrels hold is imported by the registry", async () => {
    const g = await planLinkGraph(inputs(), io);
    expect(g.bootRegistering).toEqual(["/s/d.core/core/desc.js"]);
    const reg = g.linked.get("/s/reg.r/index.js")!;
    expect(reg.code.startsWith(`import "/s/d.core/core/desc.js";`)).toBe(true);
    expect(g.boot.has("/s/d.core/core/desc.js")).toBe(true);
  });

  test("…but not one only a lazily loaded plugin's barrel holds", async () => {
    // `d` is reached only from a deferred app page now.
    const files: Record<string, string> = {
      ...FILES,
      "/s/a.web/__plugin.js": `import{cn}from"@plugins/kit/web";export default {contributions:[cn("x")]};`,
      "/s/y.web/__plugin.js": `import{Menu}from"@plugins/kit/web";import{helper}from"@plugins/d/core";export default {contributions:[Menu,helper]};`,
    };
    const g = await planLinkGraph(inputs(), {
      ...io,
      read: (f) => files[f] ?? null,
    });
    expect(g.bootRegistering).toEqual([]);
  });

  test("a file beside a module is addressed by its absolute artifact URL", async () => {
    const g = await planLinkGraph(inputs(), io);
    expect(g.linked.get("/s/x.web/__plugin.js")!.code).toContain(
      `new URL("/artifacts/x.web/web/shot.png",import.meta.url)`,
    );
    expect([...g.assetDirs]).toEqual(["x.web"]);
  });

  test("any other relative use of import.meta fails the link", async () => {
    const files: Record<string, string> = {
      ...FILES,
      "/s/a.web/__plugin.js": `const here=import.meta.url;export default {here};`,
    };
    let message = "";
    try {
      await planLinkGraph(inputs(), { ...io, read: (f) => files[f] ?? null });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("uses import.meta");
  });

  test("an import no artifact serves and no map names fails the link", async () => {
    const files: Record<string, string> = {
      ...FILES,
      "/s/a.web/__plugin.js": `import{z}from"@plugins/nowhere/web";export default {z};`,
    };
    let message = "";
    try {
      await planLinkGraph(inputs(), { ...io, read: (f) => files[f] ?? null });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(`"@plugins/nowhere/web"`);
  });
});

describe("bundleLinkGraph", () => {
  const bundle = async () => {
    const g = await planLinkGraph(inputs(), io);
    const chunks = await bundleLinkGraph(g, {
      minify: false,
      isExternal: (spec) => spec === "menu-vendor",
      log: () => {},
    });
    const chunkOf = (id: string) =>
      chunks.find((c) => c.moduleIds.includes(id));
    return { g, chunks, chunkOf };
  };

  test("an app's shared component never lands in a boot chunk, nor boot code in an app chunk", async () => {
    const { chunkOf } = await bundle();
    const menu = chunkOf("/s/kit.web/web/components/menu.js")!;
    const cn = chunkOf("/s/kit.web/web/cn.js")!;
    expect(menu.fileName).not.toBe(cn.fileName);
    expect(menu.moduleIds).not.toContain("/s/a.web/__plugin.js");
    // Only the apps load it: the boot chunk does not import it.
    expect(cn.imports).not.toContain(menu.fileName);
  });

  test("chunks are content-addressed store entries, imported by relative URL", async () => {
    const { chunks } = await bundle();
    for (const c of chunks)
      expect(c.fileName).toMatch(/^chunk\.[0-9a-f]{16}\/index\.js$/);
    const entry = chunks.find((c) => c.isEntry)!;
    expect(entry.code).toMatch(/from "\.\.\/chunk\.[0-9a-f]{16}\/index\.js"/);
  });

  test("the boot-registering descriptor is in a chunk the boot loads", async () => {
    const { chunkOf, chunks } = await bundle();
    const desc = chunkOf("/s/d.core/core/desc.js");
    expect(desc).toBeDefined();
    const entry = chunks.find((c) => c.isEntry)!;
    const reachable = new Set<string>([entry.fileName]);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of chunks) {
        if (!reachable.has(c.fileName)) continue;
        for (const i of c.imports)
          if (!reachable.has(i)) {
            reachable.add(i);
            grew = true;
          }
      }
    }
    expect(reachable.has(desc!.fileName)).toBe(true);
  });
});

describe("linkKey", () => {
  test("moves with any artifact address, the tier split and the page scripts", () => {
    const base = linkKey(inputs());
    expect(linkKey(inputs())).toBe(base);
    expect(
      linkKey(
        inputs({
          artifacts: [...inputs().artifacts.slice(1), web("kit.web2", "kit")],
        }),
      ),
    ).not.toBe(base);
    expect(linkKey(inputs({ eager: new Set(["kit"]) }))).not.toBe(base);
    expect(linkKey(inputs({ pageScripts: ["@plugins/a/web"] }))).not.toBe(base);
  });
});
