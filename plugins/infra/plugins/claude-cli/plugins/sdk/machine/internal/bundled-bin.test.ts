import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { bundledClaudeBin, bundledClaudePackages } from "./bundled-bin";

describe("bundledClaudePackages", () => {
  test("one package per platform, glibc before musl unless musl", () => {
    expect(bundledClaudePackages("darwin", "arm64", false)).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
    ]);
    expect(bundledClaudePackages("linux", "x64", false)).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
    ]);
    expect(bundledClaudePackages("linux", "x64", true)[0]).toBe(
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
    );
    expect(bundledClaudePackages("win32", "x64", false)).toEqual([
      "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
    ]);
  });
});

test("bundledClaudeBin resolves the installed SDK's platform binary", () => {
  const bin = bundledClaudeBin();
  expect(bin).toContain("claude-agent-sdk-");
  expect(existsSync(bin)).toBe(true);
});
