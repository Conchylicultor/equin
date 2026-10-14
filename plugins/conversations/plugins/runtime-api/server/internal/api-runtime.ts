import type {
  ConversationRuntime,
  RuntimeInfo,
} from "@plugins/conversations/server";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";

export const apiRuntime: ConversationRuntime = {
  id: "api",
  async list(): Promise<Map<string, RuntimeInfo>> {
    return new Map();
  },
  // Hosts nothing yet, so every id is "no live session" and there is nothing
  // to signal. A real implementation signals in-process from its own send and
  // exit paths.
  async inspect(): Promise<Map<string, RuntimeInfo>> {
    return new Map();
  },
  async subscribe(): Promise<() => void> {
    return () => {};
  },
  async isRunning(): Promise<boolean> {
    return false;
  },
  async create(
    _conversationId: string,
    _cwd: string,
    _launch: LaunchFragment,
    _opts?: { prompt?: string },
  ): Promise<void> {
    throw new Error("api runtime: create() not implemented");
  },
  async delete(): Promise<void> {
    throw new Error("api runtime: delete() not implemented");
  },
  async send(): Promise<void> {
    throw new Error("api runtime: send() not implemented");
  },
  async interrupt(): Promise<void> {
    throw new Error("api runtime: interrupt() not implemented");
  },
  async answerPrompt(): Promise<void> {
    throw new Error("api runtime: answerPrompt() not implemented");
  },
  async flushInteractivePrompt(): Promise<void> {
    throw new Error("api runtime: flushInteractivePrompt() not implemented");
  },
  async waitUntilReady(): Promise<"ready" | "timeout"> {
    throw new Error("api runtime: waitUntilReady() not implemented");
  },
  async answerMenu(): Promise<void> {
    throw new Error("api runtime: answerMenu() not implemented");
  },
};
