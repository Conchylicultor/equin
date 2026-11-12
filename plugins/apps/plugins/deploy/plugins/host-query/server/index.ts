import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { hostOnlyQueryOverSsh } from "./internal/host-query";
export type {
  HostQueryAnswer,
  HostQueryOptions,
} from "./internal/query-over-ssh";

export default {
  description:
    "hostOnlyQueryOverSsh(deploymentId, path, schema, { maxAnswerBytes? }): resolves a deployment's server and pinned SSH target, curls one host-only route of the install through its own gateway on the loopback port (two SSH sessions at most), refuses an answer over maxAnswerBytes unread (curl --max-filesize on the box, re-checked here), and answers the parsed answer, which of SSH, the request or the answer failed, or not-found.",
} satisfies ServerPluginDefinition;
