/**
 * The namespace ownership rule, and in particular that it is SYMMETRIC.
 *
 * A single-label namespace is ambiguous — `sonata` could be the composition
 * `sonata` on main, or the main composition on a checkout named `sonata` — and
 * both would resolve to one spec dir, one socket and one database. So neither
 * side wins: whichever claims an occupied name is refused. These tests pin both
 * halves, because a guard that only ever ran on one side is how the collision
 * became possible in the first place.
 */

import { describe, expect, test } from "bun:test";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  namespaceCollision,
  type NamespaceProbe,
} from "./composition-namespace";

const SONATA = asNamespace("sonata");
const AS_COMPOSITION = { kind: "composition", id: "sonata" } as const;
const AS_CHECKOUT = { kind: "checkout", name: "sonata" } as const;

const clean: NamespaceProbe = {
  specDirExists: false,
  hasCompositionMarker: false,
  gitWorktreeDirExists: false,
  branchExists: false,
  compositionIdExists: false,
};

describe("namespaceCollision — a composition claiming a namespace", () => {
  test("fresh namespace → no collision", () => {
    expect(namespaceCollision(SONATA, AS_COMPOSITION, clean)).toBeNull();
  });

  test("re-serving our own marker-carrying namespace → no collision", () => {
    expect(
      namespaceCollision(SONATA, AS_COMPOSITION, {
        ...clean,
        specDirExists: true,
        hasCompositionMarker: true,
      }),
    ).toBeNull();
  });

  test("spec dir without our marker → collision (never overwrite a foreign namespace)", () => {
    expect(
      namespaceCollision(SONATA, AS_COMPOSITION, {
        ...clean,
        specDirExists: true,
      }),
    ).toContain("WITHOUT");
  });

  test("same-named git worktree checkout or branch → collision", () => {
    expect(
      namespaceCollision(SONATA, AS_COMPOSITION, {
        ...clean,
        gitWorktreeDirExists: true,
      }),
    ).toContain("worktree");
    expect(
      namespaceCollision(SONATA, AS_COMPOSITION, {
        ...clean,
        branchExists: true,
      }),
    ).toContain("branch");
  });

  test("a manifest row of its own name is not a collision — that row IS the claimant", () => {
    expect(
      namespaceCollision(SONATA, AS_COMPOSITION, {
        ...clean,
        compositionIdExists: true,
      }),
    ).toBeNull();
  });
});

describe("namespaceCollision — a checkout claiming a namespace", () => {
  test("fresh namespace → no collision", () => {
    expect(namespaceCollision(SONATA, AS_CHECKOUT, clean)).toBeNull();
  });

  test("a composition of that name exists → collision", () => {
    expect(
      namespaceCollision(SONATA, AS_CHECKOUT, {
        ...clean,
        compositionIdExists: true,
      }),
    ).toContain("composition");
  });

  test("a served composition already holds the spec dir → collision", () => {
    expect(
      namespaceCollision(SONATA, AS_CHECKOUT, {
        ...clean,
        specDirExists: true,
        hasCompositionMarker: true,
      }),
    ).toContain("composition.json");
  });

  test("a marker-less spec dir is not a checkout's problem", () => {
    // The mirror of the composition side's "WITHOUT marker" arm: that dir
    // belongs to a git worktree, and a checkout re-claiming its own namespace
    // (a re-created worktree of the same name) is ordinary, not a collision.
    expect(
      namespaceCollision(SONATA, AS_CHECKOUT, {
        ...clean,
        specDirExists: true,
      }),
    ).toBeNull();
  });
});

describe("namespaceCollision — a host alias", () => {
  test("neither side may claim an alias's name", () => {
    const equin = asNamespace("equin");
    for (const claimant of [
      { kind: "composition", id: "equin" },
      { kind: "checkout", name: "equin" },
    ] as const) {
      expect(namespaceCollision(equin, claimant, clean)).toContain(
        "host alias",
      );
    }
  });
});
