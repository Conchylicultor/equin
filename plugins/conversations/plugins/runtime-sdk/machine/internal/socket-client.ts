import { connect } from "node:net";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  CommandReplySchema,
  HelloReplySchema,
  PartialStreamLineSchema,
  PROTOCOL_VERSION,
  applyPartialFrame,
  SubscribeReplySchema,
  type AgentCommand,
  type HelloReply,
  type PartialMessage,
} from "../../core";
import { agentSocketPath } from "./paths";

/** No agent listens on the conversation's socket: the process is gone. */
export class AgentNotRunningError extends Error {
  constructor(readonly conversationId: string) {
    super(`no SDK agent is running for ${conversationId}`);
    this.name = "AgentNotRunningError";
  }
}

/**
 * The agent took the connection but did not reply: it is wedged, or exiting
 * (a reply cut short by its exit). Its state is unknown — never "dead".
 */
export class AgentUnresponsiveError extends Error {
  constructor(
    readonly conversationId: string,
    detail: string,
  ) {
    super(`SDK agent ${conversationId}: ${detail}`);
    this.name = "AgentUnresponsiveError";
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
 * {@link AgentNotRunningError}; no reply is {@link AgentUnresponsiveError};
 * anything else throws as itself (the state is unknown, not "dead").
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
          new AgentUnresponsiveError(
            conversationId,
            `no reply to ${commands.map((c) => c.type).join(", ")} within ${COMMAND_TIMEOUT_MS}ms`,
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
        new AgentUnresponsiveError(
          conversationId,
          "closed the connection before replying",
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

/** An open `subscribe` connection. */
export interface PartialSubscription {
  close(): void;
}

/**
 * Open a `subscribe` connection (after its `hello`): resolves once the agent
 * replied. `onMessage` hears the message being streamed — first the agent's
 * snapshot, then the fold of every frame after it (in order, from the same
 * buffer, so no frame can overtake the snapshot) — and `onClose` the
 * connection ending, once: with null when the agent exited or `close()` was
 * called, with the error when the stream broke (a line that did not parse, a
 * frame that does not apply) — the connection is then closed, never left
 * half-read.
 * Rejects like a command: {@link AgentNotRunningError} when nobody listens.
 * Only for an agent whose `hello` advertised `stream`.
 */
export function subscribeAgent(
  conversationId: string,
  onMessage: (message: PartialMessage | null) => void,
  onClose: (broken: Error | null) => void,
): Promise<PartialSubscription> {
  return new Promise((resolve, reject) => {
    const conn = connect(agentSocketPath(conversationId));
    let buf = "";
    let replies = 0;
    let open = false;
    let message: PartialMessage | null = null;
    let broken: Error | null = null;
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `SDK agent ${conversationId}: no reply to subscribe within ${COMMAND_TIMEOUT_MS}ms`,
          ),
        ),
      COMMAND_TIMEOUT_MS,
    );
    function fail(err: Error): void {
      clearTimeout(timer);
      conn.destroy();
      reject(err);
    }
    conn.on("connect", () => {
      conn.write(
        [hello, { type: "subscribe" } satisfies AgentCommand]
          .map((c) => JSON.stringify(c) + "\n")
          .join(""),
      );
    });
    /** One line off the socket; false once the connection is done with. */
    function take(text: string): boolean {
      const line: unknown = JSON.parse(text);
      if (open) {
        message = applyPartialFrame(
          message,
          PartialStreamLineSchema.parse(line).frame,
        );
        onMessage(message);
        return true;
      }
      const reply = CommandReplySchema.parse(line);
      if (!reply.ok) {
        fail(
          new AgentCommandError(
            conversationId,
            replies === 0 ? "hello" : "subscribe",
            reply.error,
          ),
        );
        return false;
      }
      if (++replies < 2) return true;
      message = SubscribeReplySchema.parse(reply.result);
      open = true;
      clearTimeout(timer);
      onMessage(message);
      resolve({ close: () => conn.destroy() });
      return true;
    }
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const text = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          if (!take(text)) return;
        } catch (err) {
          // Thrown here it would take the whole backend down with it.
          const error = err instanceof Error ? err : new Error(String(err));
          if (!open) {
            fail(error);
            return;
          }
          broken = error;
          conn.destroy();
          return;
        }
      }
    });
    conn.on("error", (err: NodeJS.ErrnoException) => {
      if (open) return; // `close` follows, and reports the end
      fail(
        err.code === "ENOENT" || err.code === "ECONNREFUSED"
          ? new AgentNotRunningError(conversationId)
          : err,
      );
    });
    conn.on("close", () => {
      if (open) onClose(broken);
      else
        fail(
          new Error(
            `SDK agent ${conversationId} closed the connection before replying`,
          ),
        );
    });
  });
}
