import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformAsync } from "@babel/core";
import componentSourceBabelPlugin from "./index";

const ROOT = "/repo";
const FILE = `${ROOT}/src/thing.tsx`;

async function stamp(code: string): Promise<string> {
  const contribution = componentSourceBabelPlugin({ repoRoot: ROOT });
  const result = await transformAsync(code, {
    babelrc: false,
    configFile: false,
    filename: FILE,
    parserOpts: { sourceType: "module", plugins: ["jsx", "typescript"] },
    plugins: [contribution.plugin as never],
  });
  if (result?.code == null) throw new Error("babel returned no code");
  return result.code;
}

const STAMP = (name: string) => `${name}.__equinSource = "src/thing.tsx";`;

describe("loss-detector component-source stamp", () => {
  it("stamps every PascalCase component binding whose own body calls a hook", async () => {
    const out = await stamp(`
      export function Decl() { const [a] = useState(0); return a; }
      export default function Def() { React.useReducer(r, 0); return null; }
      const Arrow = () => { use(ctx); return null; };
      export const Memo = memo(forwardRef((p, ref) => { useState(1); return null; }));
      function Plain() { return null; }
      function Outer() { const f = () => useState(0); return f; }
      const helper = () => { useState(0); };
      function useThing() { return useState(0); }
    `);
    expect(out).toContain(STAMP("Decl"));
    expect(out).toContain(STAMP("Def"));
    expect(out).toContain(STAMP("Arrow"));
    expect(out).toContain(STAMP("Memo"));
    // No hook of its own (Outer's is in a nested function), not a component
    // name, or a hook: no state of a component of its own to judge.
    expect(out).not.toContain("Plain.__equinSource");
    expect(out).not.toContain("Outer.__equinSource");
    expect(out).not.toContain("helper.__equinSource");
    expect(out).not.toContain("useThing.__equinSource");
    // Exactly one stamp per binding.
    expect(out.split(STAMP("Memo")).length).toBe(2);
  });

  it("the stamp evaluates after the binding exists", async () => {
    const out = await stamp(
      `const Arrow = () => { useState(0); return null; };`,
    );
    const ran = new Function(
      "useState",
      `${out}\nreturn Arrow.__equinSource;`,
    ) as (u: unknown) => unknown;
    expect(ran(() => 0)).toBe("src/thing.tsx");
  });

  it("applies only to a module that names a hook", () => {
    const { appliesTo } = componentSourceBabelPlugin({ repoRoot: ROOT });
    expect(appliesTo({ id: FILE, code: "const A = () => useState(0);" })).toBe(
      true,
    );
    expect(appliesTo({ id: FILE, code: "export const a = 1;" })).toBe(false);
  });

  it("stamps the property the detector reads", () => {
    const fiber = readFileSync(
      join(import.meta.dir, "../web/internal/fiber.ts"),
      "utf8",
    );
    expect(fiber).toContain('COMPONENT_SOURCE_PROP = "__equinSource"');
  });
});
