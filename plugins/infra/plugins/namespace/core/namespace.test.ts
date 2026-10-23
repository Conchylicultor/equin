/**
 * The namespace identity, and in particular the two properties the rest of the
 * system leans on:
 *
 *   - the ELISION is total and preserves every URL in use today
 *     (`singularity`, `sonata`, `att-X` all still mint themselves);
 *   - everything `namespaceFor` can produce is something `asNamespace` accepts,
 *     so a minted namespace is always a legal path segment / DB name.
 *
 * The second is the one that matters most: `NAMESPACE_RE` is what the gateway's
 * own regex is pinned to, and a namespace that escapes it would be a path
 * hazard, not a display bug.
 */

import { test, expect } from "bun:test";
import {
  namespaceFor,
  namespaceParts,
  asNamespace,
  isNamespace,
  namespaceFromHost,
  namespaceHost,
  namespaceUrl,
  MAIN_COMPOSITION_ID,
  MAIN_WORKTREE_NAME,
  NAMESPACE_RE,
  type CheckoutRef,
} from "./namespace";

const MAIN: CheckoutRef = { kind: "main" };
const WT = (name: string): CheckoutRef => ({ kind: "worktree", name });

test("the elision rule maps the four (composition, checkout) cases", () => {
  // Main composition on main: the namespace IS the composition id.
  expect(namespaceFor(MAIN_COMPOSITION_ID, MAIN)).toBe(
    asNamespace("singularity"),
  );
  // Main composition on a worktree: the prefix elides — today's agent URL.
  expect(namespaceFor(MAIN_COMPOSITION_ID, WT("att-x"))).toBe(
    asNamespace("att-x"),
  );
  // A composition on main: the suffix elides — today's compose-serve URL.
  expect(namespaceFor("sonata", MAIN)).toBe(asNamespace("sonata"));
  // Neither elides: the one shape that needs the gateway change.
  expect(namespaceFor("sonata", WT("att-x"))).toBe(asNamespace("sonata.att-x"));
});

test("every minted namespace is a legal namespace", () => {
  const compositions = [
    MAIN_COMPOSITION_ID,
    "sonata",
    "a",
    "agent-manager-lean",
  ];
  const checkouts: CheckoutRef[] = [
    MAIN,
    WT("att-x"),
    WT("att-1787064474-2qcq"),
    WT(MAIN_COMPOSITION_ID),
  ];
  for (const composition of compositions) {
    for (const checkout of checkouts) {
      const ns = namespaceFor(composition, checkout);
      expect(NAMESPACE_RE.test(ns)).toBe(true);
      expect(() => asNamespace(ns)).not.toThrow();
    }
  }
});

test("namespaceFor refuses inputs that are not single labels", () => {
  for (const bad of [
    "",
    "Sonata",
    "so nata",
    "-sonata",
    "so/nata",
    "so.nata",
    "a".repeat(64),
  ]) {
    expect(() => namespaceFor(bad, MAIN)).toThrow("Invalid composition id");
    expect(() => namespaceFor("sonata", WT(bad))).toThrow(
      "Invalid checkout name",
    );
  }
});

test("asNamespace refuses the shapes that would stop being one safe path segment", () => {
  for (const good of ["singularity", "att-x", "sonata.att-x", "a", "a-1.b-2"]) {
    expect(() => asNamespace(good)).not.toThrow();
    expect(isNamespace(good)).toBe(true);
  }
  // `..` / empty labels / leading + trailing dots are the path hazards; `a.b.c`
  // is refused because the model has exactly two axes, not three.
  for (const bad of [
    "",
    "..",
    "a..b",
    ".a",
    "a.",
    "a.b.c",
    "A",
    "a/b",
    `${"a".repeat(64)}.b`,
    // 64 bytes: both labels are legal, the whole is one over the datname cap.
    `${"a".repeat(32)}.${"b".repeat(31)}`,
  ]) {
    expect(() => asNamespace(bad)).toThrow("Invalid namespace");
    expect(isNamespace(bad)).toBe(false);
  }
  // Exactly at the cap is fine — 63 bytes is what Postgres stores intact.
  expect(isNamespace(`${"a".repeat(31)}.${"b".repeat(31)}`)).toBe(true);
});

/**
 * The 63-byte cap, at the minter.
 *
 * Both halves can be individually legal labels and still compose past what
 * Postgres keeps: `datname` is `NAMEDATALEN - 1` = 63 bytes and truncates
 * silently, so two long namespaces sharing a 63-byte prefix would share ONE
 * database while both kept appearing to work. It throws here rather than being
 * caught by a check because only the join of (composition, checkout) knows the
 * resulting length, and the checkout half is a worktree name invented at
 * runtime.
 */
test("namespaceFor refuses a composed namespace over the 63-byte cap", () => {
  const c = "c".repeat(32);
  const w = "w".repeat(31); // 32 + 1 + 31 = 64
  expect(() => namespaceFor(c, WT(w))).toThrow("the limit is 63");
  // One byte shorter is exactly the cap, and must still mint.
  const ns = namespaceFor(c, WT("w".repeat(30)));
  expect(ns).toHaveLength(63);
  expect(NAMESPACE_RE.test(ns)).toBe(true);
  // The elided forms are single labels, so the cap can never bite there.
  expect(namespaceFor(MAIN_COMPOSITION_ID, WT(w))).toBe(asNamespace(w));
  expect(namespaceFor(c, MAIN)).toBe(asNamespace(c));
});

test("namespaceFromHost round-trips namespaceHost and rejects the loopback hosts", () => {
  for (const ns of ["singularity", "att-x", "sonata.att-x"] as const) {
    expect(namespaceFromHost(namespaceHost(asNamespace(ns)))).toBe(
      asNamespace(ns),
    );
  }
  // Port optional, case-insensitive, trailing root dot tolerated.
  expect(namespaceFromHost("sonata.att-x.localhost")).toBe(
    asNamespace("sonata.att-x"),
  );
  expect(namespaceFromHost("SONATA.att-x.localhost:9000")).toBe(
    asNamespace("sonata.att-x"),
  );
  expect(namespaceFromHost("sonata.att-x.localhost.:9000")).toBe(
    asNamespace("sonata.att-x"),
  );

  // "No namespace here" — the gateway answers the same way for these.
  for (const bare of [
    "localhost",
    "localhost:9000",
    "127.0.0.1:9000",
    "[::1]:9000",
    "example.com",
  ]) {
    expect(namespaceFromHost(bare)).toBeNull();
  }
  // A host under .localhost whose name is not a legal namespace is not one.
  expect(namespaceFromHost("a.b.c.localhost:9000")).toBeNull();

  // A host alias reads back as the namespace it stands for, in any spelling.
  expect(namespaceFromHost("equin.localhost:9000")).toBe(MAIN_WORKTREE_NAME);
  expect(namespaceFromHost("EQUIN.localhost.")).toBe(MAIN_WORKTREE_NAME);
});

test("namespaceUrl builds an origin, and refuses a path that would double the slash", () => {
  const ns = asNamespace("sonata.att-x");
  expect(namespaceUrl(ns)).toBe("http://sonata.att-x.localhost:9000");
  expect(namespaceUrl(ns, "/api/health")).toBe(
    "http://sonata.att-x.localhost:9000/api/health",
  );
  expect(() => namespaceUrl(ns, "api/health")).toThrow('must start with "/"');
});

test("namespaceParts reads back the pair only where the name fixes it", () => {
  // Two labels: neither half elided, so both are named.
  expect(namespaceParts(namespaceFor("sonata", WT("att-x")))).toEqual({
    kind: "pair",
    composition: "sonata",
    checkout: "att-x",
  });
  // One label: either half may have elided — handed back undecided.
  expect(
    namespaceParts(namespaceFor(MAIN_COMPOSITION_ID, WT("att-x"))),
  ).toEqual({ kind: "label", label: "att-x" });
  expect(namespaceParts(namespaceFor("sonata", MAIN))).toEqual({
    kind: "label",
    label: "sonata",
  });
  expect(namespaceParts(namespaceFor(MAIN_COMPOSITION_ID, MAIN))).toEqual({
    kind: "label",
    label: MAIN_COMPOSITION_ID,
  });
});
