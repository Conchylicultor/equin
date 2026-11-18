import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/** Where `usingSlot` is exported from: the barrel, or its own module inside it. */
const SLOT_USE_SOURCES: readonly string[] = [
  "@plugins/packages/plugins/semaphore/core",
  "./lease-scope",
];

/**
 * `usingSlot` holds a use-scoped gate slot (the live read gate) for the length
 * of the `start` it is handed — so `start` must be a LEAF use of a resource
 * (a DB statement, a file call, a child process) that waits on no other gate.
 * Handed anything else, a holder could wait on work whose owners wait on the
 * slot: the class of bug use-scoped slots exist to make inexpressible. So only
 * the resource primitives may import it, each a sanctioned exemption in its own
 * `exempt/index.ts`.
 */
export default createRule({
  name: "slot-use-site",
  meta: {
    type: "problem",
    docs: {
      description:
        "Only the resource primitives (the DB driver, the fs and spawn hooks a host installs) may hold a use-scoped gate slot through usingSlot.",
    },
    schema: [],
    messages: {
      slotUseSite:
        "`usingSlot` holds a live read's gate slot for as long as `start` runs, so only a resource primitive " +
        "may call it, around one LEAF use — a DB statement, a file call, a child process — that waits on no " +
        "other gate. Anything else (a mutex, another caller's flight, a worker reply) must simply be awaited: " +
        "a use-scoped slot is released while its body waits on it, with nothing to call. A new kind of resource " +
        "is a `SlotUse` added in packages/semaphore plus a sanctioned exemption in the primitive's own " +
        "exempt/index.ts (research/2026-11-18-network-read-admit-use-scoped-slots.md).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!SLOT_USE_SOURCES.includes(node.source.value)) return;
        for (const spec of node.specifiers) {
          // A namespace import reaches `usingSlot` as a member: it is refused
          // too (the barrel's other names have named imports).
          if (spec.type === "ImportNamespaceSpecifier") {
            context.report({ node: spec, messageId: "slotUseSite" });
            continue;
          }
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "usingSlot"
          ) {
            context.report({ node: spec, messageId: "slotUseSite" });
          }
        }
      },
    };
  },
});
