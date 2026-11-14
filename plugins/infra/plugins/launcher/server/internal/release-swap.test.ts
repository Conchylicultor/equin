import { describe, expect, test } from "bun:test";
import {
  RUNTIME_FORWARDED_ENV,
  envName,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { releaseBackendSpec } from "./release-swap";

const manifest = {
  composition: "website",
  target: "website",
  platform: "linux-x64",
  builtAt: "2026-11-14T00:00:00Z",
  port: 9100,
  runId: "run-2",
};

describe("releaseBackendSpec", () => {
  const spec = releaseBackendSpec(
    "/srv/equin/website/runtime/equin-release/website-abc",
    manifest,
    asNamespace("website"),
  );

  test("runs the bundle's own server, web tree and identity", () => {
    expect(spec.command).toEqual([
      "/srv/equin/website/runtime/equin-release/website-abc/server",
    ]);
    expect(spec.web).toBe(
      "/srv/equin/website/runtime/equin-release/website-abc/web",
    );
    expect(spec.env?.[envName("MIGRATIONS_DIR")]).toBe(
      "/srv/equin/website/runtime/equin-release/website-abc/migrations/data",
    );
    expect(spec.env?.[envName("RELEASE_RUN_ID")]).toBe("run-2");
    expect(spec.env?.[envName("RELEASE_COMPOSITION")]).toBe("website");
  });

  test("every path into the bundle stays out of the gateway's inherited env", () => {
    // A forwarded name would reach a swapped-in backend from the gateway — the
    // previous release's value — and the spec's own would merely override it
    // by luck of ordering. None of the spec's names may be forwarded.
    const forwarded = new Set(
      Object.keys(RUNTIME_FORWARDED_ENV).map((k) =>
        envName(k as keyof typeof RUNTIME_FORWARDED_ENV),
      ),
    );
    for (const name of Object.keys(spec.env ?? {})) {
      expect(forwarded.has(name)).toBe(false);
      expect(
        spec.env?.[name]?.includes("website-abc") || name.includes("RELEASE_"),
      ).toBe(true);
    }
  });
});
