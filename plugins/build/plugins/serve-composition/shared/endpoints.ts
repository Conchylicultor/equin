import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  isNamespace,
  NAMESPACE_LABEL_RE,
} from "@plugins/infra/plugins/namespace/core";

// Shared endpoint contracts for the serve capability — imported by BOTH this
// plugin's own web (the controls) and its server (the handlers). A plugin
// importing its own `shared/` is boundary-legal.
export const ResetCompositionBodySchema = z.object({ id: z.string() });
export type ResetCompositionBody = z.infer<typeof ResetCompositionBodySchema>;

export const resetCompositionData = defineEndpoint({
  route: "POST /api/build/serve/reset",
  body: ResetCompositionBodySchema,
  response: z.object({ ok: z.boolean() }),
});

/**
 * Whether a namespace is *actually being served right now* — a discriminated
 * union rather than one flat object with nullable fields, so a caller cannot
 * read a missing commit as a live serve.
 */
export const ServeLivenessSchema = z.discriminatedUnion("served", [
  z.object({ served: z.literal(false) }),
  z.object({
    served: z.literal(true),
    /**
     * The commit the serve build composed this namespace from. `null` for a
     * marker written before the field existed, or for a build whose HEAD did not
     * resolve — unknown, never guessed.
     */
    commit: z.string().nullable(),
    builtAt: z.string(),
  }),
]);
export type ServeLiveness = z.infer<typeof ServeLivenessSchema>;

export const ServeStatusResponseSchema = z.object({
  /**
   * WHERE this composition is — or would be — served from the backend that
   * answered: `namespaceFor(composition, <this backend's checkout>)`. Server
   * truth, and it has to be: a namespace is `<composition>.<checkout>` with both
   * sentinels elided, and the browser knows only the namespace it is talking to,
   * which does not decompose back into a checkout. A client that composed this
   * itself would name `sonata` from every worktree and link at main's namespace.
   */
  namespace: z.string().refine(isNamespace, "not a valid namespace"),
  /** `http://<namespace>.localhost:9000` — resolved beside the namespace it belongs to. */
  url: z.string(),
  liveness: ServeLivenessSchema,
  /**
   * Whether the automatic serve modes (`push` and the cadences) are actually
   * acted on by the backend that answered. A fact about THIS BACKEND, like
   * `namespace` and unlike `liveness`: the composition arm of the build
   * convergence loop runs on main only, because the durable `git.refAdvanced`
   * event is emitted only from main and a per-worktree schedule would have every
   * live agent worktree rebuilding the same compositions.
   *
   * The surface must not promise a trigger this backend does not run: offering
   * "On every push" from a worktree, where nothing will ever act on it, is the
   * same class of lie as linking at a namespace that 502s.
   */
  autoTriggersHere: z.boolean(),
});
export type ServeStatusResponse = z.infer<typeof ServeStatusResponseSchema>;

/**
 * The *truth* about a served composition, as opposed to the `serve` mode stored
 * in config: the `composition.json` marker a serve build writes into the
 * namespace dir. Intent can be on with nothing built yet (the enabling build has
 * not run, or it failed), so a surface reading `serve` as liveness offers links
 * to namespaces that 502.
 *
 * `composition` is the manifest item's **id**, not its display name (the two
 * diverge for UI-created compositions) and no longer the namespace either: a
 * composition is served from whichever checkout built it, so the namespace is
 * the ANSWER this endpoint returns rather than the question it is asked.
 */
export const serveStatusEndpoint = defineEndpoint({
  route: "GET /api/build/serve/status",
  // A composition id is one LABEL of a namespace — validated as such here, so a
  // malformed id is a 400 rather than a throw inside `namespaceFor`.
  query: z.object({
    composition: z
      .string()
      .refine((v) => NAMESPACE_LABEL_RE.test(v), "not a valid composition id"),
  }),
  response: ServeStatusResponseSchema,
  // Every deployment row and every composition row of the same namespace asks
  // the identical question; the answer is a stat + a small JSON read, so
  // collapsing a burst onto one handler run is free.
  dedupe: true,
});

/**
 * ONE namespace a composition currently occupies, described in the terms the
 * delete confirmation has to name it in: the address that stops working and
 * whether real data sits behind it.
 *
 * `host`/`url` are resolved SERVER-side beside the namespace they belong to, for
 * the same reason `ServeStatusResponse` resolves them: a namespace is
 * `<composition>.<checkout>` with both sentinels elided, and the browser cannot
 * compose or decompose that pair.
 */
export const OwnedNamespaceSchema = z.object({
  namespace: z.string().refine(isNamespace, "not a valid namespace"),
  /** `<namespace>.localhost:9000` — the display form. */
  host: z.string(),
  /** `http://<namespace>.localhost:9000` — the full origin. */
  url: z.string(),
  /**
   * Whether a Postgres database of that name exists RIGHT NOW. Read rather than
   * assumed: a namespace whose database was already dropped (an earlier reclaim,
   * a legacy registry-only entry) must not be announced as losing one.
   */
  hasDatabase: z.boolean(),
  /**
   * Which checkout composed this namespace, straight off its provenance marker.
   * All three marker arms are rendered rather than collapsed — a marker written
   * before the `checkout` field existed genuinely does not say, and reporting
   * that as "main" would name the wrong checkout to the person confirming.
   */
  builtBy: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("main") }),
    z.object({ kind: z.literal("checkout"), checkout: z.string() }),
    z.object({ kind: z.literal("unknown") }),
  ]),
});
export type OwnedNamespaceInfo = z.infer<typeof OwnedNamespaceSchema>;

/**
 * What happened to ONE namespace in a reclaim — a discriminated outcome, never a
 * tally. A count of successes cannot say WHICH namespace still holds a database,
 * and "3 of 4" read as success is exactly how a stranded namespace becomes
 * invisible.
 *
 * `refused` and `failed` are kept apart because they mean different things to
 * whoever has to act: a refusal is a guard rejecting the target with nothing
 * touched, a failure is a reclaim that broke partway and may have taken some of
 * the namespace's artifacts with it.
 */
export const ReclaimOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reclaimed") }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
]);
export type ReclaimOutcome = z.infer<typeof ReclaimOutcomeSchema>;

export const ReclaimCompositionBodySchema = z.object({ id: z.string() });
export type ReclaimCompositionBody = z.infer<
  typeof ReclaimCompositionBodySchema
>;

/**
 * Reclaim every namespace this composition owns: its database, config dir,
 * gateway registry dir (spec + dist + marker) and the composing checkout's
 * filtered registries, per namespace.
 *
 * One namespace's failure does not abort the rest — each is an independent set
 * of artifacts, and one undroppable database must not strand the other three —
 * so the response reports every namespace individually and the caller decides
 * what a partial result means. It never means success.
 */
export const reclaimCompositionNamespaces = defineEndpoint({
  route: "POST /api/build/serve/reclaim",
  body: ReclaimCompositionBodySchema,
  response: z.object({
    results: z.array(
      z.object({
        namespace: z.string().refine(isNamespace, "not a valid namespace"),
        outcome: ReclaimOutcomeSchema,
      }),
    ),
  }),
});
