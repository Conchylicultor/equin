import { describe, expect, test } from "bun:test";
import { extractDeploySecrets } from "./extract";

describe("extractDeploySecrets", () => {
  test("reads each call's static key and description", () => {
    const src = `
      import { defineDeploySecret } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";
      // defineDeploySecret({ key: "IN_A_COMMENT", description: "no" })
      export const RESEND_API_KEY = defineDeploySecret({
        key: "RESEND_API_KEY",
        description: "Sends the contact form's notification emails.",
      });
      export const OTHER = defineDeploySecret({ description: 'Second one.', key: 'OTHER_KEY' });
    `;
    expect(extractDeploySecrets(src, "core/internal/secrets.ts")).toEqual([
      {
        key: "RESEND_API_KEY",
        description: "Sends the contact form's notification emails.",
        file: "core/internal/secrets.ts",
      },
      {
        key: "OTHER_KEY",
        description: "Second one.",
        file: "core/internal/secrets.ts",
      },
    ]);
  });

  test("skips the factory's own definition", () => {
    const src = `export function defineDeploySecret(spec: { key: string }): DeploySecret { return x; }`;
    expect(extractDeploySecrets(src, "core/internal/declare.ts")).toEqual([]);
  });

  test("a declaration it cannot read statically throws, naming the line", () => {
    expect(() =>
      extractDeploySecrets(
        `\nconst A = defineDeploySecret(spec);`,
        "core/a.ts",
      ),
    ).toThrow("core/a.ts:2");
    expect(() =>
      extractDeploySecrets(
        `defineDeploySecret({ key: PREFIX + "_KEY", description: "x" })`,
        "core/b.ts",
      ),
    ).toThrow("`key` must be a static");
  });
});
