/**
 * `readServedDeployment` as the process it exists for runs it: a CLI, which
 * declares NO runtime namespace (`./equin version cut`, main's convergence
 * run). It once read the dist through `webDistDir()`, which throws there, and
 * the trailer read swallowed the throw — every cut was refused with "the
 * served dist carries no .build-commit" on a dist that carried one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import {
  declareRuntimeNamespace,
  hasRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { resetRuntimeNamespaceForTest } from "@plugins/infra/plugins/runtime-identity/core/testing";
import { readServedDeployment } from "./served-deployment";

const NS = asNamespace("served-deployment-test");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const originalDir = readEnv("DIR");
const originalNamespace = hasRuntimeNamespace() ? runtimeNamespace() : null;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "served-deployment-"));
  setEnv("DIR", root);
  // A CLI: no runtime namespace at all.
  resetRuntimeNamespaceForTest();
});

afterEach(() => {
  if (originalDir === undefined) unsetEnv("DIR");
  else setEnv("DIR", originalDir);
  resetRuntimeNamespaceForTest();
  if (originalNamespace !== null) declareRuntimeNamespace(originalNamespace);
  rmSync(root, { recursive: true, force: true });
});

function web(d: Awaited<ReturnType<typeof readServedDeployment>>) {
  const carrier = d.deployable.find((c) => c.id === "web");
  if (carrier === undefined) throw new Error("no web carrier");
  return carrier;
}

test("a process with no runtime namespace reads the named namespace's dist trailers", async () => {
  const dist = worktreeArtifacts.webDist(NS);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, ".build-commit"), `${SHA}\n`);
  writeFileSync(join(dist, ".build-graph"), "graph-1\n");

  const carrier = web(await readServedDeployment(NS));
  expect(carrier.commit).toEqual({ resolved: true, value: SHA });
  expect(carrier.graph).toEqual({ resolved: true, value: "graph-1" });
});

test("a dist without trailers reads as unresolved, not as an error", async () => {
  const carrier = web(await readServedDeployment(NS));
  expect(carrier.commit.resolved).toBe(false);
  expect(carrier.graph.resolved).toBe(false);
});
