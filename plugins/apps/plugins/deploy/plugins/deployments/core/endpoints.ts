import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { DeploymentSchema } from "./schemas";
import { DeployRunSchema } from "./runs";

/**
 * A hostname converge will render into a Caddy site block, so it is validated at
 * the door rather than at the moment it reaches `/etc/caddy` — an unvalidated
 * hostname carrying whitespace, a newline or a brace is a config-injection
 * vector, and the door is the only place a human can be told which one they
 * typed. `*.example.com` is allowed: Caddy serves wildcard sites natively.
 */
const HOSTNAME_RE =
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const HostnameSchema = z
  .string()
  .max(253)
  .regex(
    HOSTNAME_RE,
    "must be a lowercase DNS hostname (optionally `*.`-prefixed)",
  );

const HostnamesSchema = z.array(HostnameSchema);

/**
 * The gateway runs as the derived, unprivileged `svc-<composition>` user, so it
 * cannot bind a privileged port at all — the floor is a structural fact, not a
 * preference. The DB's `(serverId, loopbackPort)` unique index rejects a
 * collision with another install on the same box.
 */
const LoopbackPortSchema = z.number().int().min(1024).max(65535);

export const CreateDeploymentBodySchema = z.object({
  compositionId: z.string(),
  serverId: z.string(),
  hostnames: HostnamesSchema.optional(),
  loopbackPort: LoopbackPortSchema.optional(),
});
export type CreateDeploymentBody = z.infer<typeof CreateDeploymentBodySchema>;

/**
 * Deliberately has no `compositionId` or `serverId`: that pair IS the
 * deployment's identity, and editing it in place would leave the old host
 * converged and running an install no row describes any more — an orphan nothing
 * would ever clean up. Point a composition at a different server by deleting the
 * deployment and creating the new one, which is also the only sequence that
 * makes the abandoned host visible to the person doing it.
 */
export const UpdateDeploymentBodySchema = z.object({
  hostnames: HostnamesSchema.optional(),
  loopbackPort: LoopbackPortSchema.optional(),
});
export type UpdateDeploymentBody = z.infer<typeof UpdateDeploymentBodySchema>;

export const listDeployments = defineEndpoint({
  route: "GET /api/deploy/deployments",
  response: z.array(DeploymentSchema),
});

/**
 * `compositionId` is checked against the `compositions` config here — a name
 * that is not a live composition is a 400 naming what is known, because the row
 * is runtime data and a stale name must fail when someone saves it rather than
 * at the next build. A duplicate `(compositionId, serverId)` is a 409, and so is
 * a `loopbackPort` already taken on that server; both verdicts come from the
 * DB's own unique indexes, so they hold under concurrent writes.
 */
export const createDeployment = defineEndpoint({
  route: "POST /api/deploy/deployments",
  body: CreateDeploymentBodySchema,
  response: DeploymentSchema,
});

export const getDeployment = defineEndpoint({
  route: "GET /api/deploy/deployments/:id",
  response: DeploymentSchema,
});

export const updateDeployment = defineEndpoint({
  route: "PATCH /api/deploy/deployments/:id",
  body: UpdateDeploymentBodySchema,
  response: DeploymentSchema,
});

/**
 * Forgets the record only. The converged host keeps its unit, its files and its
 * Caddy site until someone tears it down — this app has no de-converge verb yet,
 * and pretending otherwise by deleting the row silently would be worse than
 * saying so here.
 */
export const deleteDeployment = defineEndpoint({
  route: "DELETE /api/deploy/deployments/:id",
});

/**
 * A release run id, as `ship --release` takes it.
 *
 * Constrained rather than free text because the CLI joins it onto a local
 * releases path AND interpolates it into a remote path inside a generated shell
 * script — so `..` or a quote reaching that far is a traversal / injection
 * vector. The door is the only place the person who typed it can be told.
 */
const ReleaseRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "must be a plain release run id");

/**
 * Which verb to launch. A discriminated union rather than
 * `{ verb, release? }`, so `--release` on a `converge` — a flag that verb does
 * not have — is unrepresentable at the call site instead of being ignored at the
 * argv builder.
 */
export const RunDeploymentBodySchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("converge") }),
  z.object({
    verb: z.literal("ship"),
    /** Omitted → the `latest` symlink for `<composition>-web`. */
    release: ReleaseRunIdSchema.optional(),
  }),
  /**
   * The one-button verb: converge, build a candidate if the existing bundle is
   * not already current, then ship the run id that build produced.
   *
   * It takes NO fields, and that is the point. Every input it would otherwise
   * need is discovered rather than typed: the platform from the server's health
   * probe, and the release run id from `resolveBundle` after the build — so
   * there is no way to ask for a deploy of the wrong bundle to the wrong host.
   */
  z.object({ verb: z.literal("update") }),
]);
export type RunDeploymentBody = z.infer<typeof RunDeploymentBodySchema>;

/**
 * Launch `./equin deploy <verb> <composition> --server <serverId>` for
 * this deployment, streaming its stdout/stderr into the `deploy` log channel.
 *
 * Returns as soon as the command is spawned — a converge on a cold box installs
 * Caddy and a ship uploads ~600MB, so the run's outcome arrives through the
 * `deploy.runs` resource rather than this response. A 409 means a run is already
 * in flight for this deployment's *server*: converge writes `/etc/caddy` and
 * runs `apt-get`, so two of them on one box would race.
 *
 * Every OTHER refusal is the CLI's, reached after this returns 200 — the command
 * exits non-zero, its message lands on the log channel and on the run's
 * `message`, and the run's status is `failed`. That is deliberate: the refusals
 * (never-verified server, non-Linux host, owner-data closure, platform
 * mismatch, missing bundle, un-converged host) are the CLI's to own, and
 * duplicating any of them here would create a second place to keep them right.
 */
export const runDeployment = defineEndpoint({
  route: "POST /api/deploy/deployments/:id/run",
  body: RunDeploymentBodySchema,
  response: DeployRunSchema,
});
