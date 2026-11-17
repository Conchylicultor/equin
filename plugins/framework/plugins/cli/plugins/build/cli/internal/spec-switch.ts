import type { AdoptVerdict } from "@plugins/build/plugins/restart-skip/core";
import type { DistPublication } from "./dist-publish";

/**
 * How a deploy moved its namespace's spec:
 *
 * - `kept` — the spec names ANOTHER checkout (main's previous slot), and the
 *   backend running from there adopted this deploy (it runs code identical to
 *   this tree's): the spec is left naming it, so a respawn boots the code that
 *   runs, and nothing runs from this tree.
 * - `written` — the spec names this tree now. `askedFirst` is the running
 *   backend's answer when it was asked before the switch (none when the spec
 *   already named this tree, or the deploy restarts nothing). `restore` puts
 *   the previous spec back — set only for a switch from another checkout, for
 *   a deploy that ends with the previous backend still serving
 *   ({@link settleFailedServe}).
 */
export type SpecSwitch =
  | { kind: "kept"; servedFrom: string }
  | {
      kind: "written";
      askedFirst: AdoptVerdict | null;
      restore: (() => Promise<void>) | null;
    };

/**
 * Point a namespace's spec at this tree (`spec`), the way main's slots need
 * it (`infra/git/main-slots`): a SWITCH from another checkout is asked BEFORE
 * the spec moves — the running backend judges whether this tree's code is
 * the code it runs (build/restart-skip, by content) — and an adopted switch
 * leaves the spec alone. Otherwise the build hands the tree over first
 * (`handOver`: main's slot build turns its exclusive lease shared, so the
 * backend about to boot from it is granted its own), then writes the spec.
 */
export async function switchSpec<S extends { server: string }>(i: {
  spec: S;
  /** The spec this deploy replaces (`null`: none yet). */
  previous: S | null;
  /** `--no-restart`: nothing is restarted, so nothing is asked. */
  restart: boolean;
  /** Do two `server` dirs name the same checkout (resolved)? */
  sameCheckout: (a: string, b: string) => Promise<boolean>;
  /** Ask the running backend to adopt this deploy. */
  ask: () => Promise<AdoptVerdict>;
  handOver: () => Promise<void>;
  write: (spec: S) => Promise<void>;
}): Promise<SpecSwitch> {
  // The previous spec, when it names ANOTHER checkout.
  const switchedFrom: S | null =
    i.previous !== null &&
    !(await i.sameCheckout(i.previous.server, i.spec.server))
      ? i.previous
      : null;
  let askedFirst: AdoptVerdict | null = null;
  if (switchedFrom !== null && i.restart) {
    askedFirst = await i.ask();
    if (askedFirst.kind === "adopted")
      return { kind: "kept", servedFrom: switchedFrom.server };
  }
  await i.handOver();
  await i.write(i.spec);
  return {
    kind: "written",
    askedFirst,
    restore: switchedFrom === null ? null : () => i.write(switchedFrom),
  };
}

/**
 * Settle a deploy whose serve step failed, by which backend it left serving:
 * the new one (`this-tree`) keeps the new frontend, the one every respawn
 * boots; the previous one gets its frontend back AND its spec (`restore`, a
 * switch from another checkout), so a respawn boots what is serving and no
 * spec names the tree this build ran in. The reason lines to add.
 */
export async function settleFailedServe(i: {
  backend: "previous" | "this-tree";
  publication: DistPublication;
  restore: (() => Promise<void>) | null;
  site: string;
}): Promise<string[]> {
  if (i.backend === "this-tree") {
    await i.publication.keep();
    return [
      `The new frontend stays published: it matches the backend code every respawn of ${i.site} boots.`,
    ];
  }
  await i.publication.revert();
  if (i.restore !== null) await i.restore();
  return [
    ...(i.restore !== null
      ? [
          `${i.site}'s spec names the checkout it serves from again (the previous build's).`,
        ]
      : []),
    i.publication.revertible
      ? `The new frontend was rolled back with it: ${i.site} serves the previous build, frontend and backend alike.`
      : `There was no previous frontend to roll back to, so the new one stays published.`,
  ];
}
