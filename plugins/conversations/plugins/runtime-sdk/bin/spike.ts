// SDK agent spike harness: drives bin/agent.ts the way a backend would, one
// scenario per open question of the SDK Claude track. Each scenario prints
// its verdict and writes a results JSON under <sdk-agents>/_spike/results/.
//
//   ./singularity run plugins/conversations/plugins/runtime-sdk/bin/spike.ts <scenario>
//   scenarios: restart | ask | auth | rewind | terminal | latency | all
//
// The "backend" is `spike.ts observe …`, run as its own process so it can be
// SIGKILLed mid-turn: it tails events.jsonl from a cursor file (standing in
// for the DB row) and appends every event it applies to a log, so the harness
// can check afterwards that nothing was lost or applied out of order.
// See research/2026-10-19-conversations-sdk-agent-spike.md.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { basename, dirname, join } from "node:path";
import {
  AGENT_EVENTS_FILE,
  AGENT_OPTIONS_FILE,
  AgentEventSchema,
  CommandReplySchema,
  PROTOCOL_VERSION,
  type AgentCommand,
  type AgentEvent,
  type AgentLaunchOptions,
} from "../core";
import {
  HOME_DIR,
  resolveClaudeBin,
} from "@plugins/infra/plugins/paths/server";
import { sdkAgentsDir } from "../data-dirs";
import { socketsDir } from "@plugins/infra/plugins/launcher/data-dirs";
import {
  watchForCommand,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/cli";

const AGENT_BIN = join(import.meta.dir, "agent.ts");
const spikeRoot = () => join(sdkAgentsDir.ensure(), "_spike");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── events + socket ───────────────────────────────────────────────────────
function readEvents(dir: string, after = 0): AgentEvent[] {
  const path = join(dir, AGENT_EVENTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => AgentEventSchema.parse(JSON.parse(l)))
    .filter((e) => e.seq > after);
}

/**
 * Watches an agent's events file the way a backend will: @parcel/watcher via
 * the file-watcher engine, ONE subscription per directory for the harness's
 * life (starting and stopping a native watch per wait crashed bun 1.4.3).
 * `writesWhileOpen`: the agent appends to a file it holds open, which FSEvents
 * alone does not report promptly.
 */
const dirWatches = new Map<
  string,
  { listeners: Set<() => void>; ready: Promise<FileWatcher> }
>();
async function onEvents(
  dir: string,
  listener: () => void,
): Promise<() => void> {
  let entry = dirWatches.get(dir);
  if (!entry) {
    mkdirSync(dir, { recursive: true });
    const listeners = new Set<() => void>();
    const ready = watchForCommand({
      name: "sdk-spike.events",
      dirs: [dir],
      extensions: [".jsonl"],
      writesWhileOpen: true,
      debounceMs: 5,
      onChange: () => {
        for (const l of listeners) l();
      },
    });
    entry = { listeners, ready };
    dirWatches.set(dir, entry);
  }
  await entry.ready;
  entry.listeners.add(listener);
  const { listeners } = entry;
  return () => listeners.delete(listener);
}

/** Resolves with the first event (after `after`) matching `pred`, pushed by the watcher. */
async function waitForEvent(
  dir: string,
  pred: (e: AgentEvent) => boolean,
  timeoutMs: number,
  after = 0,
): Promise<AgentEvent> {
  let settle!: (e: AgentEvent) => void;
  const found = new Promise<AgentEvent>((resolve) => (settle = resolve));
  const check = () => {
    const hit = readEvents(dir, after).find(pred);
    if (hit) settle(hit);
  };
  const unlisten = await onEvents(dir, check);
  check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `timed out after ${timeoutMs} ms waiting for an event in ${dir}`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([found, timeout]);
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

/** An agent's command socket: `sockets/agents/<id>.sock`, named by its directory's basename (the id). */
const socketOf = (dir: string) =>
  socketsDir.subdir("agents").file(`${basename(dir)}.sock`);

async function command(dir: string, cmd: AgentCommand): Promise<unknown> {
  const sock = socketOf(dir);
  return new Promise((resolve, reject) => {
    const conn = connect(sock);
    let buf = "";
    conn.on("connect", () => conn.write(JSON.stringify(cmd) + "\n"));
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      conn.end();
      const reply = CommandReplySchema.parse(JSON.parse(buf.slice(0, nl)));
      if (reply.ok) resolve(reply.result);
      else reject(new Error(`agent refused ${cmd.type}: ${reply.error}`));
    });
    conn.on("error", reject);
  });
}

const isSdk = (type: string, subtype?: string) => (e: AgentEvent) =>
  e.kind === "sdk" &&
  (e.payload as { type?: string }).type === type &&
  (subtype === undefined ||
    (e.payload as { subtype?: string }).subtype === subtype);
const sdkPayload = <T = Record<string, unknown>>(e: AgentEvent) =>
  e.payload as T;

// ── launching an agent the production way: detached in tmux, env -i ───────
interface Agent {
  id: string;
  dir: string;
  cwd: string;
  launchedAt: number;
  /** The last seq before this process started: a resumed agent appends to its predecessor's file. */
  launchSeq: number;
}

function claudeBin(): string {
  const lookup = resolveClaudeBin();
  if (lookup.kind === "missing")
    throw new Error(
      `claude not found (searched ${lookup.searched.join(", ")})`,
    );
  return lookup.path;
}

/** The spike's old CLI flags, as the launch options file agent.ts now reads. */
function optionsFromFlags(cwd: string, flags: string[]): AgentLaunchOptions {
  const value = (name: string) => {
    const i = flags.indexOf(name);
    return i >= 0 ? (flags[i + 1] ?? null) : null;
  };
  return {
    cwd,
    claudeBin: claudeBin(),
    model: value("--model"),
    effort: null,
    settings: {},
    settingSources: ["user", "project", "local"],
    mcpServers: null,
    strictMcpConfig: false,
    resume: value("--resume"),
    resumeAt: value("--resume-at"),
    resumeDropsTurn: value("--resume-drops-turn"),
    fork: flags.includes("--fork"),
    sessionId:
      value("--resume") !== null && !flags.includes("--fork")
        ? value("--resume")!
        : crypto.randomUUID(),
    prompt: null,
  };
}

function launch(opts: {
  id: string;
  cwd: string;
  args?: string[];
  freshDir?: boolean;
}): Agent {
  const dir = join(spikeRoot(), opts.id);
  if (opts.freshDir !== false) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(opts.cwd, { recursive: true });
  if (tmuxHas(opts.id)) execFileSync("tmux", ["kill-session", "-t", opts.id]);
  // The same closed environment agent-launch's AGENT_SESSION_WRAPPER builds:
  // no ANTHROPIC_API_KEY, no token — whatever login the CLI finds via HOME.
  const path = [
    dirname(process.execPath),
    dirname(claudeBin()),
    "/usr/bin:/bin:/usr/sbin:/sbin",
  ].join(":");
  const env = ["HOME", "USER", "LOGNAME", "SHELL", "LANG"].map(
    (k) => `${k}=${process.env[k] ?? ""}`,
  );
  writeFileSync(
    join(dir, AGENT_OPTIONS_FILE),
    JSON.stringify(optionsFromFlags(opts.cwd, opts.args ?? [])),
  );
  const argv = [
    process.execPath,
    AGENT_BIN,
    "--dir",
    dir,
    "--socket",
    socketOf(dir),
  ];
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const cmd = `exec env -i ${env.map(q).join(" ")} PATH=${q(path)} TERM="$TERM" TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${argv.map(q).join(" ")} 2>>${q(join(dir, "stderr.log"))}`;
  const launchSeq = readEvents(dir).at(-1)?.seq ?? 0;
  const launchedAt = Date.now();
  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    opts.id,
    "-x",
    "200",
    "-y",
    "50",
    "-c",
    opts.cwd,
    "/bin/sh",
    "-c",
    cmd,
  ]);
  return { id: opts.id, dir, cwd: opts.cwd, launchedAt, launchSeq };
}

function tmuxHas(id: string): boolean {
  // has-session exits 1 when there is no such session: that is the answer, not a failure.
  return (
    spawnSync("tmux", ["has-session", "-t", id], { stdio: "ignore" }).status ===
    0
  );
}

async function ready(agent: Agent): Promise<Record<string, unknown>> {
  await waitForEvent(
    agent.dir,
    (e) => e.kind === "agent" && e.payload.event === "ready",
    30_000,
    agent.launchSeq,
  );
  // The socket is listening once `started` is written; `ready` is the CLI's initialize.
  return (await command(agent.dir, {
    type: "hello",
    version: PROTOCOL_VERSION,
  })) as Record<string, unknown>;
}

async function turn(
  agent: Agent,
  text: string,
): Promise<{ sentAt: number; promptUuid: string; afterSeq: number }> {
  const afterSeq = readEvents(agent.dir).at(-1)?.seq ?? 0;
  const sentAt = Date.now();
  const r = (await command(agent.dir, {
    type: "turn",
    turnId: `turn-${sentAt}`,
    text,
  })) as { promptUuid: string };
  return { sentAt, promptUuid: r.promptUuid, afterSeq };
}

async function untilResult(
  agent: Agent,
  afterSeq: number,
  timeoutMs = 180_000,
) {
  const e = await waitForEvent(agent.dir, isSdk("result"), timeoutMs, afterSeq);
  return sdkPayload<{
    subtype: string;
    result?: string;
    session_id: string;
    total_cost_usd: number;
  }>(e);
}

async function stop(agent: Agent): Promise<void> {
  if (!tmuxHas(agent.id)) return;
  await command(agent.dir, { type: "shutdown" }).catch((err: unknown) => {
    if (!(err instanceof Error && /ENOENT|ECONNREFUSED/.test(err.message)))
      throw err;
  });
  await waitForEvent(
    agent.dir,
    (e) => e.kind === "agent" && e.payload.event === "exited",
    15_000,
  );
}

function sessionId(agent: Agent): string {
  const init = readEvents(agent.dir).findLast(isSdk("system", "init"));
  if (!init) throw new Error(`no init event in ${agent.dir}`);
  return sdkPayload<{ session_id: string }>(init).session_id;
}

function transcriptPath(cwd: string, sid: string): string {
  return join(
    HOME_DIR,
    ".claude",
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${sid}.jsonl`,
  );
}

function save(name: string, data: unknown): void {
  const out = join(spikeRoot(), "results");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.json`), JSON.stringify(data, null, 2));
  console.log(`\n── ${name} ──\n${JSON.stringify(data, null, 2)}`);
}

const workDir = (name: string) => join(spikeRoot(), "work", name);
const HAIKU = ["--model", "haiku"];

// ── observer: the backend stand-in (a separate, killable process) ─────────
async function observe(
  dir: string,
  cursorFile: string,
  logFile: string,
  answer: string | undefined,
): Promise<void> {
  const applied = defineFileSink({
    id: `sdk-spike-applied:${basename(logFile)}`,
    description:
      "What one spike observer applied, in order; the restart scenario checks it for gaps",
    path: logFile,
  });
  const readCursor = () =>
    existsSync(cursorFile) ? Number(readFileSync(cursorFile, "utf8")) : 0;
  // A real backend would learn open questions from `hello` after a restart.
  const hello = (await command(dir, {
    type: "hello",
    version: PROTOCOL_VERSION,
  })) as {
    openRequests: { requestId: string }[];
  };
  applied.append(
    JSON.stringify({
      observer: process.pid,
      hello: { openRequests: hello.openRequests },
    }),
  );
  const answered = new Set<string>();
  const answerOpen = async (requestId: string) => {
    if (!answer || answered.has(requestId)) return;
    answered.add(requestId);
    await command(dir, {
      type: "answer",
      requestId,
      answer: { answers: { "Which color?": answer } },
    });
    applied.append(
      JSON.stringify({ observer: process.pid, answered: requestId }),
    );
  };
  for (const r of hello.openRequests) await answerOpen(r.requestId);
  const apply = async () => {
    for (const e of readEvents(dir, readCursor())) {
      // Apply, THEN advance the cursor: a kill between the two replays the
      // event (at-least-once), which the seq makes idempotent downstream.
      applied.append(
        JSON.stringify({
          observer: process.pid,
          seq: e.seq,
          kind: e.kind,
          type: (e.payload as { type?: string }).type,
        }),
      );
      if (e.kind === "permission_request")
        await answerOpen(e.payload.requestId);
      writeFileSync(cursorFile, String(e.seq));
      if (isSdk("result")(e)) process.exit(0);
    }
  };
  let applying = Promise.resolve();
  await onEvents(dir, () => void (applying = applying.then(apply)));
  await apply();
}

/** `from`: where a fresh backend's cursor starts (omitted: keep the saved cursor — a restart). */
function spawnObserver(
  dir: string,
  name: string,
  opts: { answer?: string; from?: number } = {},
) {
  const { answer, from } = opts;
  if (from !== undefined)
    writeFileSync(join(dir, `${name}.cursor`), String(from));
  const self = import.meta.path;
  return spawn(
    process.execPath,
    [
      self,
      "observe",
      dir,
      join(dir, `${name}.cursor`),
      join(dir, `${name}.applied.jsonl`),
      answer ?? "",
    ],
    {
      stdio: "inherit",
    },
  );
}

function appliedSeqs(
  dir: string,
  name: string,
): { seqs: number[]; observers: number; helloOpen: number[] } {
  const lines = readFileSync(join(dir, `${name}.applied.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    seqs: lines
      .filter((l) => typeof l.seq === "number")
      .map((l) => l.seq as number),
    observers: new Set(lines.map((l) => l.observer)).size,
    helloOpen: lines
      .filter((l) => l.hello)
      .map((l) => (l.hello as { openRequests: unknown[] }).openRequests.length),
  };
}

/** Every seq in (from, upTo] applied at least once? Duplicates are the at-least-once replays. */
function gapFree(seqs: number[], from: number, upTo: number) {
  const set = new Set(seqs);
  const missing = Array.from(
    { length: upTo - from },
    (_, i) => from + i + 1,
  ).filter((s) => !set.has(s));
  return {
    ok: missing.length === 0,
    range: [from + 1, upTo],
    missing,
    duplicates: seqs.length - set.size,
  };
}

// ── scenarios ─────────────────────────────────────────────────────────────
async function scenarioRestart() {
  const agent = launch({
    id: "spike-restart",
    cwd: workDir("restart"),
    args: HAIKU,
  });
  await ready(agent);

  // A: backend killed mid-tool-call; the turn finishes while it is down.
  const a = await turn(
    agent,
    "Use the Bash tool to run exactly `sleep 20 && echo slept`, then reply with exactly DONE.",
  );
  const obs1 = spawnObserver(agent.dir, "a", { from: a.afterSeq });
  await waitForEvent(
    agent.dir,
    (e) =>
      isSdk("assistant")(e) && JSON.stringify(e.payload).includes('"tool_use"'),
    60_000,
    a.afterSeq,
  );
  await sleep(1_000);
  obs1.kill("SIGKILL");
  const killedAt = Date.now();
  const resA = await untilResult(agent, a.afterSeq);
  const finishedWhileDown = Date.now() - killedAt;
  const obs2 = spawnObserver(agent.dir, "a");
  await new Promise((r) => obs2.on("exit", r));
  const lastSeqA = readEvents(agent.dir).findLast(isSdk("result"))!.seq;
  const appliedA = appliedSeqs(agent.dir, "a");

  // B: backend killed while a question is open; the restarted one answers it.
  const b = await turn(
    agent,
    'Use the AskUserQuestion tool to ask me "Which color?" with the two options Red and Blue. Then reply with only the color I picked.',
  );
  const obs3 = spawnObserver(agent.dir, "b", { from: b.afterSeq });
  await waitForEvent(
    agent.dir,
    (e) => e.kind === "permission_request",
    60_000,
    b.afterSeq,
  );
  await sleep(500);
  obs3.kill("SIGKILL");
  await sleep(5_000);
  const obs4 = spawnObserver(agent.dir, "b", { answer: "Blue" });
  await new Promise((r) => obs4.on("exit", r));
  const resB = await untilResult(agent, b.afterSeq, 10_000);
  const appliedB = appliedSeqs(agent.dir, "b");

  // C: the agent process itself dies; a new one resumes from the transcript.
  const sid = sessionId(agent);
  const tmuxServer = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", agent.id, "#{pid}"],
    { encoding: "utf8" },
  ).trim();
  const agentPid = (
    (await command(agent.dir, {
      type: "hello",
      version: PROTOCOL_VERSION,
    })) as { pid: number }
  ).pid;
  const ppid = execFileSync("ps", ["-o", "ppid=", "-p", String(agentPid)], {
    encoding: "utf8",
  }).trim();
  process.kill(agentPid, "SIGKILL");
  await sleep(500);
  const resumed = launch({
    id: "spike-restart",
    cwd: agent.cwd,
    args: [...HAIKU, "--resume", sid],
    freshDir: false,
  });
  await ready(resumed);
  const c = await turn(
    resumed,
    "Which color did I pick earlier? Reply with only the color.",
  );
  const resC = await untilResult(resumed, c.afterSeq);
  const seqAfterResume = gapFree(
    readEvents(resumed.dir).map((e) => e.seq),
    0,
    readEvents(resumed.dir).at(-1)!.seq,
  );
  await stop(resumed);

  save("restart", {
    backendKilledMidTool: {
      result: resA.result,
      turnFinishedWhileBackendDownMs: finishedWhileDown,
      observersInvolved: appliedA.observers,
      eventsApplied: gapFree(appliedA.seqs, a.afterSeq, lastSeqA),
      pass:
        resA.subtype === "success" &&
        gapFree(appliedA.seqs, a.afterSeq, lastSeqA).ok,
    },
    backendKilledWithOpenQuestion: {
      openRequestsSeenByRestartedBackendHello: appliedB.helloOpen,
      result: resB.result,
      pass: resB.result?.includes("Blue") ?? false,
    },
    agentProcessKilled: {
      agentParentPid: ppid,
      tmuxServerPid: tmuxServer,
      agentIsChildOfTmuxServer: ppid === tmuxServer,
      resumedAnswer: resC.result,
      sameSessionAfterResume: sessionId(resumed) === sid,
      eventSeqAfterResume: seqAfterResume,
      pass: resC.result?.includes("Blue") ?? false,
    },
  });
}

async function scenarioAsk() {
  const out: Record<string, unknown> = {};
  for (const mode of ["canUseTool"] as const) {
    const agent = launch({
      id: `spike-ask-${mode.toLowerCase()}`,
      cwd: workDir("ask"),
      args: HAIKU,
    });
    await ready(agent);
    const t = await turn(
      agent,
      'Use the AskUserQuestion tool to ask me "Which color?" with the two options Red and Blue. Then reply with only the color I picked.',
    );
    const first = await Promise.race([
      waitForEvent(
        agent.dir,
        (e) => e.kind === "permission_request",
        90_000,
        t.afterSeq,
      ),
      waitForEvent(agent.dir, isSdk("result"), 90_000, t.afterSeq),
    ]);
    if (first.kind === "permission_request") {
      const waitedMs = first.t - t.sentAt;
      await command(agent.dir, {
        type: "answer",
        requestId: first.payload.requestId,
        answer: { answers: { "Which color?": "Blue" } },
      });
      const res = await untilResult(agent, t.afterSeq);
      const toolResult = readEvents(agent.dir, t.afterSeq).find(
        (e) =>
          isSdk("user")(e) && JSON.stringify(e.payload).includes("tool_result"),
      );
      out[mode] = {
        intercepted: true,
        via: mode,
        requestAfterSendMs: waitedMs,
        toolResult: toolResult
          ? JSON.stringify(sdkPayload(toolResult).message).slice(0, 400)
          : null,
        result: res.result,
        pass: res.result?.includes("Blue") ?? false,
      };
    } else {
      out[mode] = {
        intercepted: false,
        result: sdkPayload<{ result?: string }>(first).result,
      };
    }
    await stop(agent);
  }
  save("ask", out);
}

async function scenarioAuth() {
  const agent = launch({ id: "spike-auth", cwd: workDir("auth"), args: HAIKU });
  const hello = await ready(agent);
  const t = await turn(agent, "Reply with exactly OK.");
  const res = await untilResult(agent, t.afterSeq);
  const init = sdkPayload<{
    apiKeySource: string;
    model: string;
    claude_code_version?: string;
  }>(readEvents(agent.dir).find(isSdk("system", "init"))!);
  const agentPid = (hello as { pid: number }).pid;
  const envOfAgent = execFileSync(
    "ps",
    ["eww", "-o", "command=", "-p", String(agentPid)],
    { encoding: "utf8" },
  );
  // v2's hello no longer carries the account (it answers before initialize).
  const account: Record<string, unknown> = { cliVersion: hello.cliVersion };
  await stop(agent);
  save("auth", {
    account: { ...account, email: account.email ? "(redacted)" : undefined },
    initApiKeySource: init.apiKeySource,
    cliVersion: init.claude_code_version,
    anthropicApiKeyInAgentEnv: envOfAgent.includes("ANTHROPIC_API_KEY="),
    oauthTokenInAgentEnv: envOfAgent.includes("CLAUDE_CODE_OAUTH_TOKEN="),
    result: res.result,
    pass:
      res.subtype === "success" && !envOfAgent.includes("ANTHROPIC_API_KEY="),
  });
}

async function scenarioRewind() {
  const cwd = workDir("rewind");
  rmSync(cwd, { recursive: true, force: true });
  const agent = launch({ id: "spike-rewind", cwd, args: HAIKU });
  await ready(agent);
  const tA = await turn(agent, "Remember the word APPLE. Reply with only OK.");
  await untilResult(agent, tA.afterSeq);
  const lastOfA = readEvents(agent.dir, tA.afterSeq).findLast(
    isSdk("assistant"),
  )!;
  const lastOfAUuid = sdkPayload<{ uuid: string }>(lastOfA).uuid;
  const tB = await turn(
    agent,
    "Remember the word BANANA. Also use the Write tool to create the file x.txt containing hi. Reply with only OK.",
  );
  await untilResult(agent, tB.afterSeq);
  const sid = sessionId(agent);
  const original = transcriptPath(cwd, sid);
  const fileAfterB = existsSync(join(cwd, "x.txt"));

  // (c) file checkpoint: restore the worktree to before turn B.
  const rewound = await command(agent.dir, {
    type: "rewindFiles",
    userMessageId: tB.promptUuid,
  });
  const fileAfterRewind = existsSync(join(cwd, "x.txt"));
  await stop(agent);
  // Conversation entries only: the CLI appends bookkeeping (`cost-state`) when a process on the session exits.
  const lines = () =>
    readFileSync(original, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((l) =>
        ["user", "assistant"].includes(
          (JSON.parse(l) as { type?: string }).type ?? "",
        ),
      ).length;
  const linesBeforeResumeAt = lines();

  // (a) truncating resume at A's last message, guarded by resumeDropsTurn.
  const r1 = launch({
    id: "spike-rewind-at",
    cwd,
    args: [
      ...HAIKU,
      "--resume",
      sid,
      "--resume-at",
      lastOfAUuid,
      "--resume-drops-turn",
      tB.promptUuid,
    ],
  });
  await ready(r1);
  const q1 = await turn(
    r1,
    "Which words did I ask you to remember? Reply with only the words.",
  );
  const a1 = await untilResult(r1, q1.afterSeq);
  const r1Sid = sessionId(r1);
  await stop(r1);
  const linesBeforeFork = lines();

  // (b) fork at the same point: a new session, the original left untouched.
  const r2 = launch({
    id: "spike-rewind-fork",
    cwd,
    args: [...HAIKU, "--resume", sid, "--resume-at", lastOfAUuid, "--fork"],
  });
  await ready(r2);
  const q2 = await turn(
    r2,
    "Which words did I ask you to remember? Reply with only the words.",
  );
  const a2 = await untilResult(r2, q2.afterSeq);
  const r2Sid = sessionId(r2);
  await stop(r2);
  const linesAfterFork = lines();

  save("rewind", {
    resumeSessionAt: {
      answer: a1.result,
      sessionIdKept: r1Sid === sid,
      // A truncating resume of the same session appends a new branch to its JSONL (old entries kept).
      transcriptLines: { before: linesBeforeResumeAt, after: linesBeforeFork },
      pass:
        (a1.result?.includes("APPLE") ?? false) &&
        !(a1.result?.includes("BANANA") ?? true),
    },
    forkAt: {
      answer: a2.result,
      newSessionId: r2Sid !== sid,
      originalTranscriptLines: {
        beforeFork: linesBeforeFork,
        afterFork: linesAfterFork,
      },
      pass:
        (a2.result?.includes("APPLE") ?? false) &&
        !(a2.result?.includes("BANANA") ?? true) &&
        r2Sid !== sid &&
        linesAfterFork === linesBeforeFork,
    },
    rewindFiles: {
      rewound,
      fileAfterB,
      fileAfterRewind,
      pass: fileAfterB && !fileAfterRewind,
    },
  });
}

async function scenarioTerminal() {
  const agent = launch({
    id: "spike-terminal",
    cwd: workDir("terminal"),
    args: HAIKU,
  });
  await ready(agent);
  const t = await turn(
    agent,
    "Use the Bash tool to run `echo hello-from-bash`, then reply with exactly DONE.",
  );
  await untilResult(agent, t.afterSeq);
  const capture = execFileSync("tmux", ["capture-pane", "-p", "-t", agent.id], {
    encoding: "utf8",
  });

  // The terminal button's exact path: main's /ws/terminal, `tmux -u attach -t <id>`.
  const ws = new WebSocket("ws://singularity.localhost:9000/ws/terminal");
  let screen = "";
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "session.create",
          cols: 200,
          rows: 50,
          command: ["tmux", "-u", "attach", "-r", "-t", agent.id],
        }),
      );
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as {
        type: string;
        data?: string;
        error?: string;
      };
      if (msg.type === "session.output") screen += msg.data;
      if (msg.type === "session.error") reject(new Error(msg.error));
    };
    ws.onerror = () => reject(new Error("terminal websocket error"));
    setTimeout(resolve, 3_000);
  });
  ws.close();
  // The agent keeps serving after a viewer attached and detached.
  const t2 = await turn(agent, "Reply with exactly STILL-HERE.");
  const after = await untilResult(agent, t2.afterSeq);
  await stop(agent);
  const plain = screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  save("terminal", {
    capturePaneShowsLog:
      capture.includes("hello-from-bash") && capture.includes("● idle"),
    capturePaneTail: capture.trimEnd().split("\n").slice(-8),
    terminalButtonPathShowsLog: plain.includes("hello-from-bash"),
    terminalButtonBytes: screen.length,
    agentUnaffected: after.result,
    pass:
      plain.includes("hello-from-bash") &&
      (after.result?.includes("STILL-HERE") ?? false),
  });
}

async function scenarioLatency() {
  const runs: Record<string, unknown> = {};
  const cases = [
    {
      name: "scratch-default-model",
      cwd: workDir("latency"),
      args: [] as string[],
    },
    // The full harness: this worktree's CLAUDE.md, hooks, guards and MCP servers.
    {
      name: "worktree-default-model",
      cwd: process.cwd(),
      args: [] as string[],
    },
  ];
  for (const c of cases) {
    const agent = launch({
      id: `spike-latency-${c.name}`,
      cwd: c.cwd,
      args: c.args,
    });
    // hello resolves once the CLI has answered initialize: the process is ready for a turn.
    await ready(agent);
    const helloAt = Date.now();
    const turns: {
      sendToFirstTokenMs: number;
      sendToFirstAssistantMs: number;
      sendToResultMs: number;
      cliTtftMs: number | null;
    }[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await turn(agent, "Reply with exactly OK.");
      const firstToken = await waitForEvent(
        agent.dir,
        (e) =>
          isSdk("stream_event")(e) &&
          sdkPayload<{ event: { type: string } }>(e).event.type ===
            "content_block_delta",
        120_000,
        t.afterSeq,
      );
      const firstAssistant = await waitForEvent(
        agent.dir,
        isSdk("assistant"),
        120_000,
        t.afterSeq,
      );
      const result = await waitForEvent(
        agent.dir,
        isSdk("result"),
        120_000,
        t.afterSeq,
      );
      turns.push({
        sendToFirstTokenMs: firstToken.t - t.sentAt,
        sendToFirstAssistantMs: firstAssistant.t - t.sentAt,
        sendToResultMs: result.t - t.sentAt,
        cliTtftMs: sdkPayload<{ ttft_ms?: number }>(firstToken).ttft_ms ?? null,
      });
    }
    // `system/init` arrives with the first turn, not at spawn.
    const init = readEvents(agent.dir).find(isSdk("system", "init"));
    const initPayload = init
      ? sdkPayload<{
          mcp_servers?: { name: string; status: string }[];
          tools?: string[];
        }>(init)
      : undefined;
    await stop(agent);
    const pick = (k: keyof (typeof turns)[number]) => {
      const xs = turns
        .map((t) => t[k])
        .filter((x): x is number => typeof x === "number")
        .sort((x, y) => x - y);
      return { p50: xs[Math.floor(xs.length / 2)], min: xs[0], max: xs.at(-1) };
    };
    runs[c.name] = {
      launchToReadyMs: helloAt - agent.launchedAt,
      mcpServers: initPayload?.mcp_servers?.map((s) => `${s.name}:${s.status}`),
      toolCount: initPayload?.tools?.length,
      sendToFirstToken: pick("sendToFirstTokenMs"),
      sendToFirstAssistant: pick("sendToFirstAssistantMs"),
      sendToResult: pick("sendToResultMs"),
      turns,
    };
  }
  save("latency", runs);
}

const scenarios: Record<string, () => Promise<void>> = {
  restart: scenarioRestart,
  ask: scenarioAsk,
  auth: scenarioAuth,
  rewind: scenarioRewind,
  terminal: scenarioTerminal,
  latency: scenarioLatency,
};

const SCENARIO_CEILING_MS = 10 * 60_000;

const [verb, ...rest] = process.argv.slice(2);
if (verb === "observe") {
  const [dir, cursor, logFile, answer] = rest;
  await observe(dir!, cursor!, logFile!, answer || undefined);
} else {
  const runs =
    verb === "all"
      ? Object.entries(scenarios)
      : Object.entries(scenarios).filter(([name]) => name === verb);
  if (runs.length === 0)
    throw new Error(
      `usage: spike.ts <${[...Object.keys(scenarios), "all"].join(" | ")}>`,
    );
  for (const [name, run] of runs) {
    // A hard ceiling per scenario: a stuck wait fails loudly instead of hanging the harness.
    let timer!: ReturnType<typeof setTimeout>;
    const ceiling = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `scenario ${name} exceeded ${SCENARIO_CEILING_MS / 60_000} min`,
            ),
          ),
        SCENARIO_CEILING_MS,
      );
    });
    await Promise.race([run(), ceiling]);
    clearTimeout(timer);
  }
  // The per-dir watchers live for the harness's life; they hold the event loop open.
  await Promise.all(
    [...dirWatches.values()].map(async (w) => (await w.ready).stop()),
  );
  process.exit(0);
}
