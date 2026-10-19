import { connect } from "node:net";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  CommandReplySchema,
  HelloReplySchema,
  PROTOCOL_VERSION,
  type AgentCommand,
  type HelloReply,
} from "../../core";
import { agentSocketPath } from "./paths";

/** No agent listens on the conversation's socket: the process is gone. */
export class AgentNotRunningError extends Error {
  constructor(readonly conversationId: string) {
    super(`no SDK agent is running for ${conversationId}`);
    this.name = "AgentNotRunningError";
  }
}

/** The agent answered a command with an error. */
export class AgentCommandError extends Error {
  constructor(
    readonly conversationId: string,
    readonly command: string,
    detail: string,
  ) {
    super(`SDK agent ${conversationId} refused ${command}: ${detail}`);
    this.name = "AgentCommandError";
  }
}

// A command is answered in milliseconds (`hello` never waits on the CLI); the
// bound only breaks a wedged agent's hold on the caller.
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Send `commands` on one connection, in order, and collect one reply per
 * command. ENOENT / ECONNREFUSED — no socket, or nobody listening on it — is
 * {@link AgentNotRunningError}; anything else throws as itself (the state is
 * unknown, not "dead").
 */
function exchange(
  conversationId: string,
  commands: readonly AgentCommand[],
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const conn = connect(agentSocketPath(conversationId));
    const replies: unknown[] = [];
    let buf = "";
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err);
      else resolve(replies);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `SDK agent ${conversationId}: no reply to ${commands.map((c) => c.type).join(", ")} within ${COMMAND_TIMEOUT_MS}ms`,
          ),
        ),
      COMMAND_TIMEOUT_MS,
    );
    conn.on("connect", () => {
      conn.write(commands.map((c) => JSON.stringify(c) + "\n").join(""));
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const reply = CommandReplySchema.parse(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        const cmd = commands[replies.length]!;
        if (!reply.ok) {
          finish(new AgentCommandError(conversationId, cmd.type, reply.error));
          return;
        }
        replies.push(reply.result);
        if (replies.length === commands.length) finish(null);
      }
    });
    conn.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        err.code === "ENOENT" || err.code === "ECONNREFUSED"
          ? new AgentNotRunningError(conversationId)
          : err,
      );
    });
    conn.on("close", () => {
      finish(
        new Error(
          `SDK agent ${conversationId} closed the connection before replying`,
        ),
      );
    });
  });
}

const hello: AgentCommand = { type: "hello", version: PROTOCOL_VERSION };

/** `hello`: the agent's liveness, readiness and open questions. */
export async function helloAgent(conversationId: string): Promise<HelloReply> {
  const [reply] = await exchange(conversationId, [hello]);
  return HelloReplySchema.parse(reply);
}

/**
 * Send one command after a `hello` on the same connection (the version check
 * every connection opens with), parsing its reply with `schema`.
 */
export async function commandAgent<T>(
  conversationId: string,
  command: AgentCommand,
  schema: ZodParser<T>,
): Promise<T> {
  const [, reply] = await exchange(conversationId, [hello, command]);
  return schema.parse(reply);
}
