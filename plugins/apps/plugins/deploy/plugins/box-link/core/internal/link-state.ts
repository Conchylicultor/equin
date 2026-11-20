import { z } from "zod";
import { SshTunnelFailureKindSchema } from "@plugins/infra/plugins/ssh/core";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { BoxBeatFrameSchema } from "./protocol";

/**
 * Why a link that was live is being re-established, within its grace:
 *
 * - `slept` — this computer slept since the box was last heard (or just woke);
 * - `restarting` — a deploy run of the deployment is active: the box's
 *   backend restarts as part of it;
 * - `network` — anything else (SSH lost, equin not answering yet).
 */
export const ReconnectCauseSchema = z.enum(["slept", "restarting", "network"]);
export type ReconnectCause = z.infer<typeof ReconnectCauseSchema>;

/**
 * What a failure says about the box once the grace is over: `down` — SSH
 * answers but equin does not (the stream refused, a 502, the stream closed);
 * `unreachable` — the SSH transport itself failed (dns, unreachable,
 * timeout, a dropped session).
 */
export const LinkFailureClassSchema = z.enum(["down", "unreachable"]);
export type LinkFailureClass = z.infer<typeof LinkFailureClassSchema>;

/**
 * Why a link is `refused` — the user must act; nothing retries it:
 * the SSH failures a respawn cannot fix (`auth`, `host-key-mismatch`,
 * `forwarding-refused` — sshd's `AllowTcpForwarding no`), and the two set-up
 * steps a link needs before it can dial at all (`no-ssh-key`: the server has
 * no key; `unverified`: its host key was never pinned by a connection check).
 */
export const LinkRefusalSchema = z.enum([
  "auth",
  "host-key-mismatch",
  "forwarding-refused",
  "no-ssh-key",
  "unverified",
]);
export type LinkRefusal = z.infer<typeof LinkRefusalSchema>;

/**
 * Where one deployment's link stands. Deploying, failed and behind-main are
 * NOT link states: the site row overlays them from the deploy runs and the
 * running commit (`deploy.site-health`).
 *
 * - `connecting` — started (the tunnel spawned), no hello yet;
 * - `live` — hello received, beats current;
 * - `reconnecting` — was live, lost, within its grace (`graceUntil`, epoch
 *   ms); `then` is what it will be once the grace runs out (and `sshKind`
 *   the transport's own failure kind, carried into `unreachable`);
 * - `down` — SSH answers, equin does not;
 * - `unreachable` — the SSH transport fails (`sshKind` when ssh said why);
 * - `refused` — see {@link LinkRefusalSchema};
 * - `outdated` — the box's release has no stream route (`route-missing`) or
 *   speaks another protocol version (`protocol`): deploy it again. Retried
 *   after the next successful deploy run.
 */
export const LinkStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connecting") }),
  z.object({ kind: z.literal("live") }),
  z.object({
    kind: z.literal("reconnecting"),
    cause: ReconnectCauseSchema,
    graceUntil: z.number(),
    then: LinkFailureClassSchema,
    /** What ssh said, when `then` is `unreachable` and it said why. */
    sshKind: SshTunnelFailureKindSchema.nullable(),
  }),
  z.object({ kind: z.literal("down") }),
  z.object({
    kind: z.literal("unreachable"),
    sshKind: SshTunnelFailureKindSchema.nullable(),
  }),
  z.object({ kind: z.literal("refused"), reason: LinkRefusalSchema }),
  z.object({
    kind: z.literal("outdated"),
    reason: z.enum(["route-missing", "protocol"]),
  }),
]);
export type LinkState = z.infer<typeof LinkStateSchema>;
export type LinkStateKind = LinkState["kind"];

/** What the box said in its last hello: the build it runs, when it started. */
export const BoxHelloInfoSchema = z.object({
  buildId: z.string().nullable(),
  /** The box backend's start (epoch ms, the box's clock). */
  startedAt: z.number(),
  /** The protocol version it spoke. */
  v: z.number().int(),
});
export type BoxHelloInfo = z.infer<typeof BoxHelloInfoSchema>;

/** The last heartbeat heard, as the box sent it. */
export const BoxBeatSchema = BoxBeatFrameSchema.omit({ kind: true });
export type BoxBeat = z.infer<typeof BoxBeatSchema>;

/**
 * One deployment's link, as this computer holds it.
 *
 * - `since` — when `state` took its current kind (epoch ms, this computer's
 *   clock);
 * - `lastHeardAt` — the last frame of any kind (epoch ms), `null` when
 *   nothing was ever heard;
 * - `lastBeat` — the last heartbeat (the meters), dimmed by the UI outside
 *   `live`;
 * - `lastError` — the last failure in words (ssh's stderr, the stream's
 *   status or error), kept until the next hello;
 * - `hello` — the last hello's build and start, `null` before the first.
 *
 * Outside `live`, `lastHeardAt` / `lastBeat` are what the box said last —
 * persisted on every state change, so a restart of this computer keeps them.
 */
export const BoxLinkSchema = z.object({
  deploymentId: z.string(),
  state: LinkStateSchema,
  since: z.number(),
  lastHeardAt: z.number().nullable(),
  lastBeat: BoxBeatSchema.nullable(),
  lastError: z.string().nullable(),
  hello: BoxHelloInfoSchema.nullable(),
});
export type BoxLink = z.infer<typeof BoxLinkSchema>;

/**
 * Every link this instance holds, keyed by deployment id — ONE value for the
 * handful of deployments. A deployment absent here is not linked from this
 * instance (a real box from a worktree: real boxes link from main only). Served
 * from memory by `box-link/link` (`source: "external"`), pushed on every
 * frame that changes it.
 */
export const boxLinks = liveValue("deploy.box-links", {
  schema: wholeRecord(BoxLinkSchema, {
    reason: "one entry per linked deployment — a handful",
  }),
  needsMachine: { feature: "The live link to a deployed site" },
});
