import { describe, test, expect } from "bun:test";
import type {
  ModelCatalog,
  ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  BASELINE_MODELS,
  ConversationModelSchema,
  DEFAULT_MODEL_CHOICE,
  ModelChoiceSchema,
  ModelUnavailableError,
} from "@plugins/conversations/plugins/model-provider/core";
import type { TaskTrack } from "@plugins/tasks/plugins/task-track/core";
import {
  fileAddTask,
  type AddTaskInput,
  type AddTaskPorts,
} from "./add-task-filing";
import {
  rewireOn,
  type DependencyGraph,
} from "../../server/internal/rewire-dependencies";

// The `add_task` filing policy over an in-memory store. The rewire runs the
// production `rewireOn` over an in-memory edge set, so the edges asserted here
// are the ones the real tool would write; only the storage is fake.

const CONV = "conv-1";
const T = "T"; // the current conversation's task
const D = "D"; // a task that already waited on T

function makeStore(catalog: ModelCatalog = BASELINE_MODELS) {
  const tasks = new Set<string>([T, D]);
  // "a->b" = a depends on b.
  const edges = new Set<string>([`${D}->${T}`]);
  const armed = new Map<string, ModelChoice>();
  const tracks = new Map<string, TaskTrack>();
  const titles = new Map<string, string>();
  let seq = 0;

  const graph: DependencyGraph = {
    add: async (a, b) => {
      edges.add(`${a}->${b}`);
    },
    remove: async (a, b) => {
      edges.delete(`${a}->${b}`);
    },
    spliceableDependentsOf: async (id) =>
      [...edges]
        .map((e) => e.split("->") as [string, string])
        .filter(([a, b]) => b === id && tracks.get(a) !== "sidequest")
        .map(([a]) => a),
    dependenciesOf: async (id) =>
      [...edges]
        .map((e) => e.split("->") as [string, string])
        .filter(([a]) => a === id)
        .map(([, b]) => b),
  };

  const ports: AddTaskPorts = {
    getConversation: async (id) => (id === CONV ? { taskId: T } : null),
    getTask: async (id) => (tasks.has(id) ? { id } : null),
    createTask: async (input) => {
      const id = `new-${++seq}`;
      tasks.add(id);
      titles.set(input.title ?? "", id);
      return { id };
    },
    inheritLaunchOptions: async () => {},
    rewire: (opts) => rewireOn(graph, opts),
    armAutoStart: async ({ taskId, model }) => {
      armed.set(taskId, model);
    },
    setTrack: async (taskId, track) => {
      if (track === "main") tracks.delete(taskId);
      else tracks.set(taskId, track);
    },
    modelCatalog: () => catalog,
  };

  const file = (
    input: Omit<AddTaskInput, "relation"> & Partial<AddTaskInput>,
  ) => fileAddTask({ relation: "followup", ...input }, CONV, ports);

  return { tasks, edges, armed, tracks, file };
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so it cannot be
 * awaited under `await-thenable`.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("add_task filing: main track vs sidequest", () => {
  test("mixed filing: sidequests hang off T in parallel, the main chain takes T's place", async () => {
    const s = makeStore();

    const s1 = await s.file({ title: "Follow up 1", track: "sidequest" });
    const s2 = await s.file({ title: "Follow up 2", track: "sidequest" });
    const m1 = await s.file({ title: "Main 1", track: "main" });
    const m2 = await s.file({
      title: "Main 2",
      track: "main",
      target: m1.task_id,
    });

    const S1 = s1.task_id;
    const S2 = s2.task_id;
    const M1 = m1.task_id;
    const M2 = m2.task_id;

    expect(s.edges).toEqual(
      new Set([
        `${S1}->${T}`,
        `${S2}->${T}`,
        `${M1}->${T}`,
        `${M2}->${M1}`,
        // D's wait moved to the end of the MAIN chain — never onto a sidequest.
        `${D}->${M2}`,
      ]),
    );

    // Only the main-track tasks are armed; sidequests carry a track row.
    expect([...s.armed.keys()].sort()).toEqual([M1, M2].sort());
    expect(s.armed.get(M1)).toBe(DEFAULT_MODEL_CHOICE);
    expect(s.tracks).toEqual(
      new Map<string, TaskTrack>([
        [S1, "sidequest"],
        [S2, "sidequest"],
      ]),
    );

    expect(s1).toMatchObject({ track: "sidequest", autostart: null });
    expect(m1).toMatchObject({
      track: "main",
      autostart: DEFAULT_MODEL_CHOICE,
    });
  });

  test("order does not matter: a sidequest filed after the main step still hangs off T", async () => {
    const s = makeStore();
    const m = await s.file({ title: "Main", track: "main" });
    const q = await s.file({ title: "Follow up", track: "sidequest" });
    expect(s.edges).toEqual(
      new Set([
        `${m.task_id}->${T}`,
        `${D}->${m.task_id}`,
        `${q.task_id}->${T}`,
      ]),
    );
  });

  test("main track honours an explicit autostart model", async () => {
    const s = makeStore();
    const m = await s.file({
      title: "Main",
      track: "main",
      autostart: "sonnet",
    });
    expect(s.armed.get(m.task_id)).toBe("sonnet");
  });

  test("a sidequest with autostart throws before anything is written", async () => {
    const s = makeStore();
    const tasksBefore = new Set(s.tasks);
    const edgesBefore = new Set(s.edges);
    const err = await rejection(
      s.file({ title: "S", track: "sidequest", autostart: "opus" }),
    );
    expect(err.message).toMatch(/never auto-started/);
    expect(s.tasks).toEqual(tasksBefore);
    expect(s.edges).toEqual(edgesBefore);
    expect(s.armed.size).toBe(0);
  });

  test("a sidequest prerequisite throws before anything is written", async () => {
    const s = makeStore();
    const tasksBefore = new Set(s.tasks);
    const err = await rejection(
      s.file({ title: "S", track: "sidequest", relation: "prerequisite" }),
    );
    expect(err.message).toMatch(/block the main track/);
    expect(s.tasks).toEqual(tasksBefore);
    expect(s.tracks.size).toBe(0);
  });
});

describe("add_task autostart: the id grammar at the schema, the catalog at filing", () => {
  // The MCP input schema is fixed when the tool registers, so it can only
  // check the grammar; a release after that must still be accepted.
  test("the schema accepts any well-formed version, known or not", () => {
    expect(ModelChoiceSchema.safeParse("sonnet-9").success).toBe(true);
    expect(ModelChoiceSchema.safeParse("opus").success).toBe(true);
    expect(ModelChoiceSchema.safeParse("gpt-4").success).toBe(false);
    expect(ModelChoiceSchema.safeParse("opus-5").success).toBe(true);
  });

  test("a version this machine's catalog never saw is refused before anything is written, listing what can run", async () => {
    const s = makeStore();
    const before = new Set(s.tasks);
    const err = await rejection(
      s.file({
        title: "Main",
        track: "main",
        autostart: ModelChoiceSchema.parse("sonnet-9"),
      }),
    );
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).status).toBe(400);
    expect(err.message).toContain("Sonnet 9 is not a model this machine knows");
    expect(err.message).toContain("pick another: Fable, Opus, Sonnet");
    expect(s.tasks).toEqual(before);
    expect(s.armed.size).toBe(0);
  });

  test("once discovery has seen it, the same version files and arms", async () => {
    const sonnet9 = ConversationModelSchema.parse("sonnet-9");
    const s = makeStore({
      ...BASELINE_MODELS,
      versions: [
        ...BASELINE_MODELS.versions,
        {
          id: sonnet9,
          firstSeenAt: "2026-10-01T00:00:00.000Z",
          source: "cli",
        },
      ],
      current: { ...BASELINE_MODELS.current, sonnet: sonnet9 },
    });
    const r = await s.file({
      title: "Main",
      track: "main",
      autostart: sonnet9,
    });
    expect(s.armed.get(r.task_id)).toBe(sonnet9);
  });

  test("a retired version is refused with its reason", async () => {
    const s = makeStore({
      ...BASELINE_MODELS,
      versions: BASELINE_MODELS.versions.map((v) =>
        v.id === "opus-4-6"
          ? {
              ...v,
              retiredAt: "2026-10-01T00:00:00.000Z",
              retiredReason: "no longer offered by Claude Code 2.2.0",
            }
          : v,
      ),
    });
    const err = await rejection(
      s.file({
        title: "Main",
        track: "main",
        autostart: ModelChoiceSchema.parse("opus-4-6"),
      }),
    );
    expect(err.message).toContain(
      "Opus 4.6 is retired (no longer offered by Claude Code 2.2.0)",
    );
    expect(err.message).not.toContain("Opus 4.6,");
  });
});
