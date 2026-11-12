import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type {
  SshRunResult,
  SshTarget,
} from "@plugins/infra/plugins/ssh/server";
import {
  hostQueryCurlArgv,
  mapSshAnswer,
  queryOverSsh,
  type DeploymentTarget,
  type ThisInstanceResponse,
} from "./query-over-ssh";

const TARGET: SshTarget = {
  host: "box.example",
  port: 22,
  user: "root",
  privateKey: "KEY",
  hostKey: { mode: "pinned", knownHostsLine: "box ssh-ed25519 AAAA" },
};

const PATH = "/api/host-only/things?q=abc_DEF-123&limit=5";

/** The URL inside the remote shell's single quotes. */
function unquoted(arg: string): string {
  expect(arg.startsWith("'") && arg.endsWith("'")).toBe(true);
  return arg.slice(1, -1);
}

const ThingsSchema = z.object({ things: z.array(z.string()) }).strict();

type SshFailureResult = Extract<SshRunResult, { ok: false }>;

function ok(stdout: string): SshRunResult {
  return { ok: true, stdout, stderr: "", learnedHostKey: null };
}

function fail(
  kind: SshFailureResult["kind"],
  exitCode: number | null,
): SshRunResult {
  return {
    ok: false,
    kind,
    message: `${kind} happened`,
    stderr: "raw stderr",
    exitCode,
  };
}

const noInstance = async (): Promise<ThisInstanceResponse> => {
  throw new Error("this instance must not be asked");
};

describe("hostQueryCurlArgv", () => {
  it("curls the install's gateway on loopback, the URL single-quoted", () => {
    const argv = hostQueryCurlArgv(9100, PATH);
    expect(argv.slice(0, 4)).toEqual(["curl", "-fsS", "-m", "10"]);
    const url = new URL(unquoted(argv[4]!));
    expect(url.origin).toBe("http://127.0.0.1:9100");
    expect(url.pathname).toBe("/api/host-only/things");
    expect(url.searchParams.get("q")).toBe("abc_DEF-123");
    // `&` reaches curl inside the quotes, not the remote shell.
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("refuses a route outside the host-only prefix", () => {
    expect(() => hostQueryCurlArgv(9100, "/api/things")).toThrow(
      /outside \/api\/host-only\//,
    );
  });

  it("refuses a path the remote shell would read", () => {
    for (const path of [
      "/api/host-only/x?q=a b",
      "/api/host-only/x;rm -rf /",
      "/api/host-only/x?q=$(id)",
      "/api/host-only/x?q='a'",
      "/api/host-only/x?q=a\\'b",
      "/api/host-only/x?q=`id`",
    ]) {
      expect(() => hostQueryCurlArgv(9100, path)).toThrow(/remote shell/);
    }
  });
});

describe("mapSshAnswer", () => {
  it("parses an answer with the caller's schema", () => {
    expect(
      mapSshAnswer(ok(JSON.stringify({ things: ["a"] })), ThingsSchema),
    ).toEqual({ kind: "answer", value: { things: ["a"] } });
  });

  it("names non-JSON stdout as unreadable, never as an empty answer", () => {
    const mapped = mapSshAnswer(
      ok("<html>502 Bad Gateway</html>"),
      ThingsSchema,
    );
    expect(mapped.kind).toBe("unreadable-answer");
    if (mapped.kind === "unreadable-answer") {
      expect(mapped.detail).toContain("502 Bad Gateway");
    }
  });

  it("names JSON the schema refuses as unreadable", () => {
    expect(
      mapSshAnswer(ok(JSON.stringify({ things: 3 })), ThingsSchema).kind,
    ).toBe("unreadable-answer");
  });

  it("maps a failed remote command to request-failed with curl's exit code", () => {
    expect(mapSshAnswer(fail("command-failed", 22), ThingsSchema)).toEqual({
      kind: "request-failed",
      exitCode: 22,
      stderr: "raw stderr",
    });
  });

  it("maps every SSH-layer failure to ssh-failed with its kind", () => {
    for (const kind of [
      "dns",
      "unreachable",
      "timeout",
      "auth",
      "host-key-mismatch",
      "unknown",
    ] as const) {
      expect(mapSshAnswer(fail(kind, 255), ThingsSchema)).toEqual({
        kind: "ssh-failed",
        failure: kind,
        message: `${kind} happened`,
        stderr: "raw stderr",
      });
    }
  });
});

describe("queryOverSsh", () => {
  it("runs the curl against the resolved target and port", async () => {
    const calls: { target: SshTarget; argv: string[] }[] = [];
    const result = await queryOverSsh(
      {
        resolveDeployment: async () => ({
          kind: "ready",
          target: TARGET,
          loopbackPort: 9123,
        }),
        sshRun: async (target, argv) => {
          calls.push({ target, argv });
          return ok(JSON.stringify({ things: [] }));
        },
        fetchThisInstance: noInstance,
      },
      "dep-1",
      PATH,
      ThingsSchema,
    );
    expect(result).toEqual({ kind: "answer", value: { things: [] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe(TARGET);
    expect(unquoted(calls[0]!.argv[4]!)).toBe(`http://127.0.0.1:9123${PATH}`);
  });

  it("never opens a session when the deployment does not resolve", async () => {
    const unresolved: DeploymentTarget[] = [
      { kind: "not-found" },
      { kind: "no-ssh-key" },
      { kind: "unverified" },
    ];
    for (const resolved of unresolved) {
      let ran = false;
      const result = await queryOverSsh(
        {
          resolveDeployment: async () => resolved,
          sshRun: async () => {
            ran = true;
            return ok("");
          },
          fetchThisInstance: noInstance,
        },
        "dep-1",
        PATH,
        ThingsSchema,
      );
      expect(result).toEqual(resolved as typeof result);
      expect(ran).toBe(false);
    }
  });
});

describe("maxAnswerBytes", () => {
  it("asks curl on the box to stop past the cap", () => {
    const argv = hostQueryCurlArgv(9100, PATH, { maxAnswerBytes: 1024 });
    const at = argv.indexOf("--max-filesize");
    expect(at).toBeGreaterThan(0);
    expect(argv[at + 1]).toBe("1024");
    // The URL stays the last, quoted argument.
    expect(unquoted(argv.at(-1)!)).toContain(PATH);
  });

  it("adds nothing when unset", () => {
    expect(hostQueryCurlArgv(9100, PATH)).not.toContain("--max-filesize");
  });

  it("refuses a non-positive or fractional cap", () => {
    expect(() =>
      hostQueryCurlArgv(9100, PATH, { maxAnswerBytes: 0 }),
    ).toThrow();
    expect(() =>
      hostQueryCurlArgv(9100, PATH, { maxAnswerBytes: 1.5 }),
    ).toThrow();
  });

  it("refuses an oversized answer unread, even when it would parse", () => {
    const big = JSON.stringify({ things: ["x".repeat(2_000)] });
    const result = mapSshAnswer(ok(big), ThingsSchema, {
      maxAnswerBytes: 1_000,
    });
    expect(result.kind).toBe("unreadable-answer");
    // Within the cap it parses as before.
    expect(
      mapSshAnswer(ok(big), ThingsSchema, { maxAnswerBytes: 10_000 }).kind,
    ).toBe("answer");
  });

  it("counts bytes, not characters", () => {
    // 400 three-byte characters: 400 chars, ~1,200 bytes.
    const wide = JSON.stringify({ things: ["€".repeat(400)] });
    expect(
      mapSshAnswer(ok(wide), ThingsSchema, { maxAnswerBytes: 1_000 }).kind,
    ).toBe("unreadable-answer");
  });
});

describe("queryOverSsh on a this-instance box", () => {
  async function ask(
    response: ThisInstanceResponse,
    path = PATH,
  ): Promise<{ result: unknown; paths: string[]; ssh: number }> {
    const paths: string[] = [];
    let ssh = 0;
    const result = await queryOverSsh(
      {
        resolveDeployment: async () => ({ kind: "this-instance" }),
        sshRun: async () => {
          ssh++;
          return ok("");
        },
        fetchThisInstance: async (p) => {
          paths.push(p);
          return response;
        },
      },
      "dep-1",
      path,
      ThingsSchema,
    );
    return { result, paths, ssh };
  }

  it("parses the gateway's answer without opening SSH", async () => {
    const { result, paths, ssh } = await ask({
      kind: "response",
      status: 200,
      body: JSON.stringify({ things: ["a"] }),
    });
    expect(result).toEqual({ kind: "answer", value: { things: ["a"] } });
    expect(paths).toEqual([PATH]);
    expect(ssh).toBe(0);
  });

  it("maps an HTTP error to curl's 22", async () => {
    const { result } = await ask({
      kind: "response",
      status: 404,
      body: "nope",
    });
    expect(result).toEqual({
      kind: "request-failed",
      exitCode: 22,
      stderr: "HTTP 404: nope",
    });
  });

  it("maps a connection failure to curl's 7", async () => {
    const { result } = await ask({ kind: "unreachable", message: "refused" });
    expect(result).toEqual({
      kind: "request-failed",
      exitCode: 7,
      stderr: "refused",
    });
  });

  it("still refuses a path outside the host-only prefix", async () => {
    let thrown: unknown;
    try {
      await ask({ kind: "response", status: 200, body: "{}" }, "/api/things");
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toMatch(/outside \/api\/host-only\//);
  });
});
