import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  backgroundShellsOf,
  exitCodeOfSummary,
  parseShellAck,
  shellFactsOf,
  shellNotificationLabel,
  shellOutputFileIn,
} from "./shells";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type TaskNotificationEvent = Extract<JsonlEvent, { kind: "task-notification" }>;

const SHELL_ID = "ba33n0xov";
const TOOL_USE_ID = "toolu_01";
const OUTPUT =
  "/private/tmp/claude-501/-Users-me-repo/9f171ddd-8ac5-4829-b57f-7b5269196555/tasks/ba33n0xov.output";
const ACK = `Command running in background with ID: ${SHELL_ID}. Output is being written to: ${OUTPUT}. You will be notified when it completes. To check interim output, use Read on that file path.`;

function bashCall(
  overrides: {
    input?: Record<string, unknown>;
    content?: string | null;
    toolUseId?: string;
  } = {},
): ToolCallEvent {
  const content = overrides.content === undefined ? ACK : overrides.content;
  return {
    kind: "tool-call",
    at: "2026-09-30T10:00:00.000Z",
    toolUseId: overrides.toolUseId ?? TOOL_USE_ID,
    name: "Bash",
    input: overrides.input ?? {
      command: "for i in $(seq 60); do echo tick $i; sleep 1; done",
      description: "Tick for a minute",
      run_in_background: true,
    },
    ...(content === null
      ? {}
      : { result: { at: "2026-09-30T10:00:01.000Z", content } }),
  };
}

function notification(
  status: string,
  summary: string,
  keys: { taskId?: string; toolUseId?: string } = {},
): TaskNotificationEvent {
  return {
    kind: "task-notification",
    at: "2026-09-30T10:01:00.000Z",
    taskId: keys.taskId ?? SHELL_ID,
    toolUseId: keys.toolUseId ?? TOOL_USE_ID,
    status,
    summary,
    outputFile: OUTPUT,
  };
}

function taskStop(
  taskId: string,
  opts: { isError?: boolean; pending?: boolean } = {},
): ToolCallEvent {
  return {
    kind: "tool-call",
    at: "2026-09-30T10:00:30.000Z",
    toolUseId: "toolu_stop",
    name: "TaskStop",
    input: { task_id: taskId },
    ...(opts.pending === true
      ? {}
      : {
          result: {
            at: "2026-09-30T10:00:31.000Z",
            content: `{"message":"Successfully stopped task: ${taskId}"}`,
            ...(opts.isError === true ? { isError: true } : {}),
          },
        }),
  };
}

describe("parseShellAck", () => {
  test("reads the id and the path out of the launch acknowledgement", () => {
    expect(parseShellAck(ACK)).toEqual({
      shellId: SHELL_ID,
      outputFile: OUTPUT,
    });
  });

  test("anything else is not an acknowledgement", () => {
    expect(parseShellAck("Error: command not found")).toBeNull();
  });
});

describe("exitCodeOfSummary", () => {
  test("reads the stated exit code", () => {
    expect(
      exitCodeOfSummary('Background command "x" failed (exit code 1)'),
    ).toBe(1);
  });
  test("reads Claude Code's failure wording, which has no parentheses", () => {
    expect(
      exitCodeOfSummary('Background command "x" failed with exit code 144'),
    ).toBe(144);
  });
  test("an exit code inside the label does not answer", () => {
    expect(
      exitCodeOfSummary('Background command "echo exit code 3" was stopped'),
    ).toBeNull();
  });
  test("null when the summary states none", () => {
    expect(exitCodeOfSummary('Background command "x" was stopped')).toBeNull();
  });
});

describe("backgroundShellsOf", () => {
  test("a launch with its acknowledgement and no notification, conversation live: running", () => {
    const shells = backgroundShellsOf({
      events: [bashCall()],
      conversationStatus: "working",
    });
    expect(shells).toEqual([
      {
        shellId: SHELL_ID,
        toolUseId: TOOL_USE_ID,
        command: "for i in $(seq 60); do echo tick $i; sleep 1; done",
        description: "Tick for a minute",
        outputFile: OUTPUT,
        startedAt: new Date("2026-09-30T10:00:00.000Z"),
        state: { kind: "running" },
        endedAt: null,
      },
    ]);
  });

  test("completed with exit 0", () => {
    const [shell] = backgroundShellsOf({
      events: [
        bashCall(),
        notification(
          "completed",
          'Background command "Tick for a minute" completed (exit code 0)',
        ),
      ],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({ kind: "completed", exitCode: 0 });
    expect(shell!.endedAt).toEqual(new Date("2026-09-30T10:01:00.000Z"));
  });

  test("failed with exit 1", () => {
    const [shell] = backgroundShellsOf({
      events: [
        bashCall(),
        notification("failed", 'Background command "x" failed (exit code 1)'),
      ],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({ kind: "failed", exitCode: 1 });
  });

  test("killed", () => {
    const [shell] = backgroundShellsOf({
      events: [
        bashCall(),
        notification("killed", 'Background command "x" was stopped'),
      ],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({ kind: "killed" });
  });

  test("stopped by the agent's own TaskStop, which Claude Code does not notify: killed", () => {
    const [shell] = backgroundShellsOf({
      events: [bashCall(), taskStop(SHELL_ID)],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({ kind: "killed" });
    expect(shell!.endedAt).toEqual(new Date("2026-09-30T10:00:31.000Z"));
  });

  test("a notification wins over a TaskStop of the same shell", () => {
    const [shell] = backgroundShellsOf({
      events: [
        bashCall(),
        taskStop(SHELL_ID),
        notification("completed", "done (exit code 0)"),
      ],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({ kind: "completed", exitCode: 0 });
  });

  test("a TaskStop that failed, is pending, or names another task does not end the shell", () => {
    for (const stop of [
      taskStop(SHELL_ID, { isError: true }),
      taskStop(SHELL_ID, { pending: true }),
      taskStop("other"),
    ]) {
      const [shell] = backgroundShellsOf({
        events: [bashCall(), stop],
        conversationStatus: "working",
      });
      expect(shell!.state).toEqual({ kind: "running" });
    }
  });

  test("an unknown status still ends the shell, and says which status", () => {
    const [shell] = backgroundShellsOf({
      events: [bashCall(), notification("exploded", "boom (exit code 3)")],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({
      kind: "ended-unrecognized",
      status: "exploded",
      exitCode: 3,
    });
  });

  test("no notification and the conversation has ended: ended without reporting", () => {
    for (const conversationStatus of ["gone", "done"] as const) {
      const [shell] = backgroundShellsOf({
        events: [bashCall()],
        conversationStatus,
      });
      expect(shell!.state).toEqual({ kind: "ended-without-reporting" });
      expect(shell!.endedAt).toBeNull();
    }
  });

  test("joins the notification by tool-use id when its task id differs", () => {
    const [shell] = backgroundShellsOf({
      events: [
        bashCall(),
        notification("completed", "done (exit code 0)", { taskId: "other" }),
      ],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({ kind: "completed", exitCode: 0 });
  });

  test("a notification for another task does not end this shell", () => {
    const [shell] = backgroundShellsOf({
      events: [
        bashCall(),
        notification("completed", "done", {
          taskId: "zzz",
          toolUseId: "toolu_other",
        }),
      ],
      conversationStatus: "working",
    });
    expect(shell!.state).toEqual({ kind: "running" });
  });

  test("a background call whose result is not the acknowledgement is not a shell", () => {
    expect(
      backgroundShellsOf({
        events: [bashCall({ content: "Error: failed to start" })],
        conversationStatus: "working",
      }),
    ).toEqual([]);
  });

  test("a background call with no result yet is not a shell yet", () => {
    expect(
      backgroundShellsOf({
        events: [bashCall({ content: null })],
        conversationStatus: "working",
      }),
    ).toEqual([]);
  });

  test("a foreground call is not a shell", () => {
    expect(
      backgroundShellsOf({
        events: [bashCall({ input: { command: "ls" } })],
        conversationStatus: "working",
      }),
    ).toEqual([]);
  });

  test("shells come back in start order", () => {
    const second = `Command running in background with ID: b2. Output is being written to: /tmp/claude-501/x/y/tasks/b2.output.`;
    const shells = backgroundShellsOf({
      events: [
        bashCall(),
        bashCall({ toolUseId: "toolu_02", content: second }),
      ],
      conversationStatus: "working",
    });
    expect(shells.map((s) => s.shellId)).toEqual([SHELL_ID, "b2"]);
  });
});

describe("shellNotificationLabel", () => {
  test("reads the label of a shell's notification, whatever its verb", () => {
    expect(
      shellNotificationLabel(
        'Background command "./equin build" completed (exit code 0)',
      ),
    ).toBe("./equin build");
    expect(
      shellNotificationLabel(
        'Background command "Push branch to main" failed with exit code 1',
      ),
    ).toBe("Push branch to main");
    expect(
      shellNotificationLabel(
        'Background command "Watch" was stopped after reaching its background time limit',
      ),
    ).toBe("Watch");
  });

  test("a raw command holding quotes runs to the last quote before the verb", () => {
    expect(
      shellNotificationLabel(
        'Background command "until grep -q "^EXIT" x.log; do sleep 20; done" completed (exit code 0)',
      ),
    ).toBe('until grep -q "^EXIT" x.log; do sleep 20; done');
  });

  test("a sub-agent's or a monitor's notification is not a shell's", () => {
    expect(
      shellNotificationLabel('Agent "Find the track" finished'),
    ).toBeNull();
    expect(shellNotificationLabel('Monitor event: "x"')).toBeNull();
  });
});

describe("shellFactsOf — shells delivered from a sub-agent", () => {
  // A sub-agent's background `Bash`: its call and acknowledgement are in the
  // sub-agent's transcript; only the notification reaches this one.
  const SUB_ID = "bxy727bux";
  const SUB_OUTPUT = `/private/tmp/claude-501/-Users-me-repo/9f171ddd-8ac5-4829-b57f-7b5269196555/tasks/${SUB_ID}.output`;
  const subNotification = (status = "failed"): TaskNotificationEvent => ({
    ...notification(
      status,
      'Background command "Build promo-film composition" failed with exit code 1',
      { taskId: SUB_ID, toolUseId: "toolu_sub" },
    ),
    outputFile: SUB_OUTPUT,
  });

  test("a shell's notification with no launch here is a delivered shell", () => {
    const facts = shellFactsOf([subNotification()]);
    expect(facts.launched).toEqual([]);
    expect(facts.delivered).toEqual([
      {
        shellId: SUB_ID,
        toolUseId: "toolu_sub",
        label: "Build promo-film composition",
        outputFile: SUB_OUTPUT,
        end: {
          state: { kind: "failed", exitCode: 1 },
          endedAt: "2026-09-30T10:01:00.000Z",
        },
      },
    ]);
  });

  test("a notification that ends a launch here is that launch's end, never also delivered", () => {
    const facts = shellFactsOf([
      bashCall(),
      notification(
        "completed",
        'Background command "Tick for a minute" completed (exit code 0)',
      ),
    ]);
    expect(facts.launched).toHaveLength(1);
    expect(facts.delivered).toEqual([]);
  });

  test("a queued delivery written twice is one shell", () => {
    expect(
      shellFactsOf([subNotification(), subNotification()]).delivered,
    ).toHaveLength(1);
  });

  test("a sub-agent's own notification is not a shell", () => {
    const agent: TaskNotificationEvent = {
      ...notification("completed", 'Agent "Find the track" finished', {
        taskId: "a81312485e74b4869",
      }),
    };
    expect(shellFactsOf([agent]).delivered).toEqual([]);
  });

  test("the server resolves a delivered shell's output file from its notification", () => {
    expect(shellOutputFileIn([subNotification()], SUB_ID)).toBe(SUB_OUTPUT);
    expect(shellOutputFileIn([bashCall()], SHELL_ID)).toBe(OUTPUT);
    expect(shellOutputFileIn([bashCall()], "bnope")).toBeNull();
  });
});
