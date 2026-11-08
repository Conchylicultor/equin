import { describe, expect, test } from "bun:test";
import { defineSecretNamespace } from "./namespaces";

describe("defineSecretNamespace", () => {
  test("carries its scope; idempotent for the same scope", () => {
    const a = defineSecretNamespace("test-ns-same", { scope: "instance" });
    const b = defineSecretNamespace("test-ns-same", { scope: "instance" });
    expect(a).toEqual({ id: "test-ns-same", scope: "instance" } as typeof a);
    expect(b.scope).toBe("instance");
  });

  test("one id with two scopes throws", () => {
    defineSecretNamespace("test-ns-two", { scope: "machine" });
    expect(() =>
      defineSecretNamespace("test-ns-two", { scope: "instance" }),
    ).toThrow(/declared both/);
  });

  test("an id that is not lowercase-hyphen throws", () => {
    expect(() => defineSecretNamespace("Bad_NS", { scope: "machine" })).toThrow(
      /lowercase-hyphen/,
    );
  });
});
