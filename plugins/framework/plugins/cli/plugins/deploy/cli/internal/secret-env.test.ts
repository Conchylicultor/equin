/**
 * Deploy secrets reach the box through ONE channel — the SSH session's stdin —
 * and these tests pin that down from both ends:
 *
 * - `secretEnvStdin` is the only place a value is rendered, and the generated
 *   converge script is a function of KEYS alone, so no value can be in the
 *   uploaded script (or the argv that runs it: `["bash", <path>]`).
 * - `SECRET_ENV_SH` is run in a real bash against real stdin: it writes the
 *   approved lines through, and every word it prints — success or refusal —
 *   names keys, never values.
 */
import { describe, expect, test } from "bun:test";
import { deriveInstall } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { SECRET_ENV_SH, convergeScript } from "./converge-script";
import { secretEnvStdin } from "./secret-env";

const VALUE_A = "re_live_9f8e7d6c5b4a";
const VALUE_B = "sk-other-0123456789";

async function renderWith(
  keys: string,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `set -euo pipefail\nSECRET_KEYS=${JSON.stringify(keys)}\n${SECRET_ENV_SH}\nSECRET_ENV_LINES="$(render_secret_env)"\nprintf '%s' "$SECRET_ENV_LINES"`,
    ],
    { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("secretEnvStdin", () => {
  test("one KEY=value line per secret", () => {
    expect(
      secretEnvStdin([
        { key: "A_KEY", value: VALUE_A },
        { key: "B_KEY", value: VALUE_B },
      ]),
    ).toBe(`A_KEY=${VALUE_A}\nB_KEY=${VALUE_B}\n`);
    expect(secretEnvStdin([])).toBe("");
  });

  test("refuses a value the env file cannot hold, naming only the key", () => {
    const bad = "has space";
    expect(() => secretEnvStdin([{ key: "A_KEY", value: bad }])).toThrow(
      "A_KEY",
    );
    try {
      secretEnvStdin([{ key: "A_KEY", value: bad }]);
    } catch (err) {
      expect(String(err)).not.toContain(bad);
    }
    expect(() => secretEnvStdin([{ key: "lower", value: "x" }])).toThrow(
      "env-var name",
    );
  });
});

describe("the converge script never carries a value", () => {
  test("it is generated from keys alone, and reads values from stdin", () => {
    const text = convergeScript({
      install: deriveInstall("website"),
      hostnames: ["equin.ai"],
      loopbackPort: 9100,
      sshPort: 22,
      sshUser: "root",
      secretKeys: ["A_KEY", "B_KEY"],
    });
    expect(text).toContain("SECRET_KEYS='A_KEY B_KEY'");
    expect(text).toContain('SECRET_ENV_LINES="$(render_secret_env)"');
    expect(text).not.toContain(VALUE_A);
    expect(text).not.toContain(VALUE_B);
    // stdin is read before any command that could consume it, then closed.
    expect(text.indexOf("render_secret_env)")).toBeLessThan(
      text.indexOf("apt-get"),
    );
    expect(text).toContain("exec </dev/null");
  });
});

describe("SECRET_ENV_SH", () => {
  test("writes exactly the approved lines, and prints no value", async () => {
    const r = await renderWith(
      "A_KEY B_KEY",
      secretEnvStdin([
        { key: "A_KEY", value: VALUE_A },
        { key: "B_KEY", value: VALUE_B },
      ]),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`A_KEY=${VALUE_A}\nB_KEY=${VALUE_B}`);
    expect(r.stderr).toBe("");
  });

  test("no secrets: empty stdin, empty lines", async () => {
    const r = await renderWith("", "");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  const refusals: [string, string, string, string][] = [
    [
      "an unexpected key",
      "A_KEY",
      `A_KEY=${VALUE_A}\nB_KEY=${VALUE_B}\n`,
      "not one of: A_KEY",
    ],
    [
      "a missing key",
      "A_KEY B_KEY",
      `A_KEY=${VALUE_A}\n`,
      "B_KEY was not delivered",
    ],
    [
      "a duplicate",
      "A_KEY",
      `A_KEY=${VALUE_A}\nA_KEY=${VALUE_B}\n`,
      "A_KEY was delivered twice",
    ],
    ["a malformed line", "A_KEY", `${VALUE_A}\n`, "malformed"],
  ];
  for (const [what, keys, stdin, says] of refusals) {
    test(`refuses ${what}, naming keys only`, async () => {
      const r = await renderWith(keys, stdin);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(says);
      expect(r.stderr).not.toContain(VALUE_A);
      expect(r.stderr).not.toContain(VALUE_B);
      expect(r.stdout).not.toContain(VALUE_A);
    });
  }
});
