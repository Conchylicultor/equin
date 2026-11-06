import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { releasesDir } from "../../data-dirs";
import { bundleSignature, resolveBundle } from "./resolve-bundle";

// A namespace no backend owns, removed after the suite.
const NAMESPACE = `bundle-sig-test-${process.pid}-${Date.now()}` as Namespace;
const COMPOSITION = "comp";
const PLATFORM = "linux-x64";
const COMP_DIR = releasesDir.file(NAMESPACE, `${COMPOSITION}-web`);
const opts = {
  namespace: NAMESPACE,
  composition: COMPOSITION,
  platform: PLATFORM,
};

afterAll(() => {
  rmSync(releasesDir.file(NAMESPACE), { recursive: true, force: true });
});

function writeRun(runId: string): string {
  const runDir = join(COMP_DIR, runId);
  mkdirSync(join(runDir, "dist"), { recursive: true });
  writeFileSync(
    join(runDir, "RELEASE.json"),
    JSON.stringify({
      composition: COMPOSITION,
      target: "web",
      platform: PLATFORM,
      builtAt: new Date().toISOString(),
      port: 1,
      runId,
    }),
  );
  return runDir;
}

describe("bundleSignature — moves whenever resolveBundle's verdict can", () => {
  test("every fact resolveBundle reads changes the signature", async () => {
    const seen = new Set<string>();
    const step = async (what: string): Promise<string> => {
      const sig = await bundleSignature(opts);
      if (seen.has(sig)) throw new Error(`${what} did not move the signature`);
      seen.add(sig);
      return sig;
    };

    await step("nothing");
    expect(await resolveBundle(opts)).toMatchObject({ ok: false });

    mkdirSync(COMP_DIR, { recursive: true });
    await step("the composition dir");

    const runDir = writeRun("release-1");
    symlinkSync(runDir, join(COMP_DIR, `latest-${PLATFORM}`));
    await step("the pointer");
    expect(await resolveBundle(opts)).toMatchObject({
      ok: false,
      refusal: { kind: "not-packed" },
    });

    // The dist binary appearing is the step that makes a bundle shippable.
    const binary = join(runDir, "dist", `${COMPOSITION}-web-${PLATFORM}`);
    writeFileSync(binary, "");
    const packed = await step("the packed binary");
    expect(await resolveBundle(opts)).toMatchObject({
      ok: true,
      runId: "release-1",
    });
    expect(await bundleSignature(opts)).toBe(packed);

    const later = new Date(Date.now() + 60_000);
    utimesSync(join(runDir, "RELEASE.json"), later, later);
    await step("a rewritten manifest");

    const next = writeRun("release-2");
    writeFileSync(join(next, "dist", `${COMPOSITION}-web-${PLATFORM}`), "");
    unlinkSync(join(COMP_DIR, `latest-${PLATFORM}`));
    symlinkSync(next, join(COMP_DIR, `latest-${PLATFORM}`));
    await step("the pointer moving to another run");

    unlinkSync(join(next, "RELEASE.json"));
    await step("the manifest disappearing");
  });
});
