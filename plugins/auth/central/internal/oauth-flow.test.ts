import { expect, test } from "bun:test";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";
import { resolveOpenerOrigin } from "./oauth-flow";

test("the opener's origin is kept as given when it is a host of the claimed namespace", () => {
  for (const origin of [
    "http://equin.localhost:9000",
    "http://singularity.localhost:9000",
  ]) {
    expect(resolveOpenerOrigin(origin, MAIN_WORKTREE_NAME)).toEqual({
      kind: "ok",
      origin,
    });
  }
  expect(
    resolveOpenerOrigin("http://att-x.localhost:9000/", asNamespace("att-x")),
  ).toEqual({ kind: "ok", origin: "http://att-x.localhost:9000" });
});

test("an origin that is not a host of the claimed namespace is refused", () => {
  for (const origin of [
    "http://att-x.localhost:9000",
    "https://evil.example",
    "http://localhost:9000",
    "not a url",
  ]) {
    expect(resolveOpenerOrigin(origin, MAIN_WORKTREE_NAME).kind).toBe(
      "invalid",
    );
  }
});

test("a bundle that sends no origin gets the namespace's handed-out address", () => {
  expect(resolveOpenerOrigin(null, MAIN_WORKTREE_NAME)).toEqual({
    kind: "ok",
    origin: "http://equin.localhost:9000",
  });
});
