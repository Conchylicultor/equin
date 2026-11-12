/**
 * The MCP request path: no server instructions at initialize, live
 * descriptions on tools/list, `when` gates, the call context.
 *
 * Run: `./equin test plugins/infra/plugins/mcp`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { setServerErrorHandler } from "@plugins/framework/plugins/server-core/core/testing";
import { handleMcpRequest } from "./handle-mcp";
import { Mcp, type McpToolContext } from "../../server";
import { registry } from "../../server/internal/registry";

const CONVERSATION = "conv-test";

function post(body: unknown): Promise<Response> {
  return handleMcpRequest(
    new Request(`http://localhost/api/mcp/${CONVERSATION}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }),
    { conversationId: CONVERSATION },
  );
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
};

let reported: string[] = [];

beforeEach(() => {
  reported = [];
  setServerErrorHandler((report) => reported.push(report.message));
  registry.clear();
  void Mcp.tool({
    name: "echo",
    description: "Echo",
    inputSchema: { text: z.string() },
    handler: (args) => ({ content: [{ type: "text", text: args.text }] }),
  }).register();
});

afterEach(() => {
  registry.clear();
});

describe("server instructions", () => {
  test("initialize carries none: agent context is a system-prompt section", async () => {
    const res = await post(initialize);
    const body = (await res.json()) as { result: { instructions?: string } };
    expect(body.result.instructions).toBeUndefined();
  });
});

describe("Mcp.tool liveDescription", () => {
  let liveRenders = 0;

  function liveTool(name: string, section: string | null): void {
    void Mcp.tool({
      name,
      description: "Fixed.",
      liveDescription: () => {
        liveRenders += 1;
        return Promise.resolve(section);
      },
      inputSchema: {},
      handler: () => ({ content: [{ type: "text", text: "ok" }] }),
    }).register();
  }

  async function listed(): Promise<Map<string, string>> {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const json = (await res.json()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    return new Map(json.result.tools.map((t) => [t.name, t.description]));
  }

  beforeEach(() => {
    liveRenders = 0;
  });

  test("tools/list appends the live section after a blank line", async () => {
    liveTool("live", "Known: A, B.");
    const tools = await listed();
    expect(tools.get("live")).toBe("Fixed.\n\nKnown: A, B.");
    expect(tools.get("echo")).toBe("Echo");
  });

  test("a null section leaves the fixed description", async () => {
    liveTool("live", null);
    expect((await listed()).get("live")).toBe("Fixed.");
  });

  test("a throwing section keeps the tool listed with a notice, reported", async () => {
    void Mcp.tool({
      name: "live",
      description: "Fixed.",
      liveDescription: () => Promise.reject(new Error("db down")),
      inputSchema: {},
      handler: () => ({ content: [{ type: "text", text: "ok" }] }),
    }).register();
    const tools = await listed();
    expect(tools.get("live")).toStartWith("Fixed.\n\n");
    expect(tools.get("live")).toContain("db down");
    expect(tools.get("echo")).toBe("Echo");
    expect(reported).toEqual([
      'MCP tool "live" live description failed: db down',
    ]);
  });

  test("only tools/list renders it", async () => {
    liveTool("live", "Known.");
    await post(initialize);
    await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "live", arguments: {} },
    });
    expect(liveRenders).toBe(0);
    await listed();
    expect(liveRenders).toBe(1);
  });
});

describe("Mcp.tool when", () => {
  let gated: McpToolContext[] = [];

  function gate(name: string, visible: boolean | Promise<boolean>): void {
    void Mcp.tool({
      name,
      description: name,
      inputSchema: {},
      when: (ctx) => {
        gated.push(ctx);
        return visible;
      },
      handler: () => ({ content: [{ type: "text", text: name }] }),
    }).register();
  }

  async function listed(): Promise<string[]> {
    const res = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const json = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    return json.result.tools.map((t) => t.name);
  }

  async function call(name: string): Promise<unknown> {
    const res = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name, arguments: {} },
    });
    return res.json();
  }

  beforeEach(() => {
    gated = [];
  });

  test("a tool whose when is false is not listed", async () => {
    gate("shown", true);
    gate("shown-async", Promise.resolve(true));
    gate("hidden", false);
    expect((await listed()).sort()).toEqual(["echo", "shown", "shown-async"]);
    expect(gated).toContainEqual({ conversationId: CONVERSATION });
  });

  test("a tool whose when is false is refused on call", async () => {
    gate("hidden", Promise.resolve(false));
    const json = (await call("hidden")) as {
      result?: { isError?: boolean; content: Array<{ text: string }> };
      error?: { message: string };
    };
    // The SDK answers an unknown tool with either a JSON-RPC error or an
    // isError result depending on version; either way, the handler never ran.
    const refused =
      json.error !== undefined ||
      (json.result?.isError === true &&
        json.result.content[0]?.text !== "hidden");
    expect(refused).toBe(true);
  });

  test("a throwing when hides only its own tool, reported", async () => {
    gate("shown", true);
    gate("broken", Promise.reject(new Error("gate failed")));
    expect((await listed()).sort()).toEqual(["echo", "shown"]);
    expect(reported).toEqual(['MCP tool "broken" when failed: gate failed']);
  });

  test("a visible gated tool is callable", async () => {
    gate("shown", true);
    const json = (await call("shown")) as {
      result: { content: Array<{ text: string }> };
    };
    expect(json.result.content[0]?.text).toBe("shown");
  });
});

describe("Mcp.tool call context", () => {
  let calls = 0;
  async function toolUseIdSeen(meta: unknown): Promise<string | null> {
    let seen: string | null | undefined;
    const name = `who-${++calls}`;
    void Mcp.tool({
      name,
      description: "Who called",
      inputSchema: {},
      handler: (_args, ctx) => {
        seen = ctx.toolUseId;
        return { content: [{ type: "text", text: "ok" }] };
      },
    }).register();
    await post({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name,
        arguments: {},
        ...(meta !== undefined ? { _meta: meta } : {}),
      },
    });
    if (seen === undefined) throw new Error("the handler never ran");
    return seen;
  }

  test("the client's tool-use id reaches the handler", async () => {
    expect(await toolUseIdSeen({ "claudecode/toolUseId": "toolu_abc" })).toBe(
      "toolu_abc",
    );
  });

  test("no id sent is null", async () => {
    expect(await toolUseIdSeen(undefined)).toBeNull();
    expect(await toolUseIdSeen({ other: 1 })).toBeNull();
  });
});
