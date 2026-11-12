// The registry serializes each conversation's agent-process lifecycle: a close
// (`delete`) arriving while a launch (`create`) is still bringing the agent up
// waits for it, instead of sending `shutdown` to an agent mid-start — the race
// that failed conv-1794447287-5wdi2e's spawn (Drop & exit during its launch).
import { expect, test } from "bun:test";
import { serializeLifecycle, type ConversationRuntime } from "./runtime";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function recordingRuntime(launchDone: Promise<void>) {
  const log: string[] = [];
  const runtime = {
    id: "sdk",
    async create(id: string) {
      log.push(`create:start:${id}`);
      await launchDone;
      log.push(`create:end:${id}`);
    },
    async delete(id: string) {
      log.push(`delete:${id}`);
    },
    async stop(id: string) {
      log.push(`stop:${id}`);
      return { returnedPromptUuid: null };
    },
    async send(id: string) {
      log.push(`send:${id}`);
    },
    async answerPrompt(id: string) {
      log.push(`answer:${id}`);
    },
  } as unknown as ConversationRuntime;
  return { runtime, log };
}

const LAUNCH = { settings: {}, options: {} } as unknown as Parameters<
  ConversationRuntime["create"]
>[2];

test("a close waits for the launch in flight on the same conversation", async () => {
  const launch = deferred();
  const { runtime, log } = recordingRuntime(launch.promise);
  const serial = serializeLifecycle(runtime);

  const creating = serial.create("conv-a", "/cwd", LAUNCH);
  const deleting = serial.delete("conv-a");
  const stopping = serial.stop("conv-a");
  // Let every microtask run: nothing may reach the agent before the launch ends.
  await new Promise((r) => setTimeout(r, 0));
  expect(log).toEqual(["create:start:conv-a"]);

  launch.resolve();
  await Promise.all([creating, deleting, stopping]);
  expect(log).toEqual([
    "create:start:conv-a",
    "create:end:conv-a",
    "delete:conv-a",
    "stop:conv-a",
  ]);
});

test("other conversations never wait on one's launch", async () => {
  const launch = deferred();
  const { runtime, log } = recordingRuntime(launch.promise);
  const serial = serializeLifecycle(runtime);

  const creating = serial.create("conv-a", "/cwd", LAUNCH);
  await serial.delete("conv-b");
  await serial.send("conv-c", { turnId: "turn-1", text: "hi" });
  expect(log).toEqual(["create:start:conv-a", "delete:conv-b", "send:conv-c"]);
  launch.resolve();
  await creating;
});

test("a failed launch releases the conversation for the next op", async () => {
  const runtime = {
    id: "sdk",
    create: () => Promise.reject(new Error("exited during startup")),
    delete: async () => {},
  } as unknown as ConversationRuntime;
  const serial = serializeLifecycle(runtime);
  expect(serial.create("conv-a", "/cwd", LAUNCH)).rejects.toThrow(
    "exited during startup",
  );
  await serial.delete("conv-a");
});
