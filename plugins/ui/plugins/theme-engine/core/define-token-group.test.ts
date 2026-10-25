import { describe, expect, it } from "bun:test";

import {
  both,
  defineTokenGroup,
  tokenVarName,
  type TokenVarOf,
} from "./define-token-group";

const group = defineTokenGroup("policy", {
  icon: {
    default: "always",
    values: ["always", "never"] as const,
  },
  gapX: { default: "4px" },
});

describe("defineTokenGroup — enumerated tokens", () => {
  it("types an enumerated token's fragment value as its declared union", () => {
    const ok = group.fragment(both({ icon: "never", gapX: "1rem" }));
    expect(ok.light.icon).toBe("never");
    // @ts-expect-error — "sometimes" is not one of the token's declared values.
    group.fragment(both({ icon: "sometimes" }));
  });

  it("keeps the declared values on the schema, for the customizer and checks", () => {
    expect(group.schema.icon.values).toEqual(["always", "never"]);
    expect("values" in group.schema.gapX).toBe(false);
  });
});

describe("TokenVarOf", () => {
  it("spells each key's var exactly as tokenVarName does", () => {
    const gap: TokenVarOf<typeof group> = "--gap-x";
    expect(tokenVarName("gapX")).toBe(gap);
    // @ts-expect-error — the group declares no `--gap-y`.
    const missing: TokenVarOf<typeof group> = "--gap-y";
    expect(missing as string).toBe("--gap-y");
  });
});
